defmodule Simulator.Client do
  @moduledoc """
  A single simulated user. Holds one Mint.WebSocket connection to the Phoenix
  `/socket` endpoint, joins one group, sends messages at a configured rate.

  Uses Phoenix Channel serializer v2 (JSON arrays:
    [join_ref, ref, topic, event, payload]).
  """

  use GenServer, restart: :transient
  require Logger

  alias Mint.HTTP
  alias Mint.WebSocket, as: WS

  @vsn "2.0.0"

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, [])

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    Registry.register(Simulator.ClientRegistry, :clients, opts[:id])

    state = %{
      id: opts[:id],
      target: opts[:target],
      group: opts[:group],
      author: opts[:author],
      msgs_per_sec: opts[:msgs_per_sec],
      body_size: opts[:body_size] || 64,
      end_at: opts[:end_at],
      conn: nil,
      ws: nil,
      ref: nil,
      join_ref: "1",
      next_ref: 2,
      joined?: false
    }

    {:ok, state, {:continue, :connect}}
  end

  @impl true
  def handle_continue(:connect, state) do
    with {:ok, state} <- ws_connect(state),
         {:ok, state} <- send_join(state) do
      schedule_next_send(state)
      schedule_shutdown(state)
      {:noreply, state}
    else
      {:error, reason} ->
        Simulator.Stats.bump(:send_errors)
        Logger.debug("client #{state.id} connect failed: #{inspect(reason)}")
        {:stop, :normal, state}
    end
  end

  @impl true
  def handle_info(:send_tick, %{end_at: end_at} = state) do
    if System.monotonic_time(:millisecond) >= end_at do
      {:stop, :normal, state}
    else
      state = push_message(state)
      schedule_next_send(state)
      {:noreply, state}
    end
  end

  def handle_info(:shutdown, state), do: {:stop, :normal, state}

  def handle_info(message, %{conn: conn} = state) when not is_nil(conn) do
    case WS.stream(conn, message) do
      {:ok, conn, responses} ->
        state = handle_ws_responses(responses, %{state | conn: conn})
        {:noreply, state}

      {:error, _conn, reason, _resp} ->
        Logger.debug("ws error: #{inspect(reason)}")
        {:stop, :normal, state}

      :unknown ->
        {:noreply, state}
    end
  end

  def handle_info(_, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    if state.conn, do: HTTP.close(state.conn)
    Simulator.Stats.bump(:disconnected)
    :ok
  end

  # WebSocket / Phoenix Channel wire ------------------------------------

  defp ws_connect(state) do
    %URI{scheme: scheme, host: host, port: port, path: path} = URI.parse(state.target)
    {http_scheme, ws_scheme} = schemes(scheme)
    path = (path || "/socket/websocket") <> "?vsn=#{@vsn}&nickname=#{state.author}"

    with {:ok, conn} <- HTTP.connect(http_scheme, host, port, protocols: [:http1]),
         {:ok, conn, ref} <- WS.upgrade(ws_scheme, conn, path, []) do
      receive_upgrade(conn, ref, state)
    end
  end

  defp receive_upgrade(conn, ref, state) do
    receive do
      message ->
        case WS.stream(conn, message) do
          {:ok, conn, responses} ->
            case find_upgrade(responses, ref) do
              {:ok, status, headers} ->
                case WS.new(conn, ref, status, headers) do
                  {:ok, conn, ws} ->
                    Simulator.Stats.bump(:connected)
                    {:ok, %{state | conn: conn, ws: ws, ref: ref}}

                  err ->
                    err
                end

              :wait ->
                receive_upgrade(conn, ref, state)
            end

          other ->
            {:error, other}
        end
    after
      10_000 -> {:error, :upgrade_timeout}
    end
  end

  defp find_upgrade(responses, ref) do
    status = Enum.find_value(responses, fn
      {:status, ^ref, s} -> s
      _ -> nil
    end)

    headers = Enum.find_value(responses, fn
      {:headers, ^ref, h} -> h
      _ -> nil
    end)

    done? = Enum.any?(responses, fn {:done, ^ref} -> true; _ -> false end)

    cond do
      status && headers && done? -> {:ok, status, headers}
      true -> :wait
    end
  end

  defp schemes("ws"), do: {:http, :ws}
  defp schemes("http"), do: {:http, :ws}
  defp schemes("wss"), do: {:https, :wss}
  defp schemes("https"), do: {:https, :wss}

  defp send_join(state) do
    frame =
      phoenix_frame(
        state.join_ref,
        ref(state),
        "group:" <> state.group,
        "phx_join",
        %{}
      )

    case ws_send(state, frame) do
      {:ok, state} -> {:ok, bump_ref(state)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp push_message(state) do
    body = "#{state.author}/#{state.id}/#{System.unique_integer([:positive])}"
    body = pad(body, state.body_size)

    frame =
      phoenix_frame(
        state.join_ref,
        ref(state),
        "group:" <> state.group,
        "send",
        %{body: body}
      )

    case ws_send(state, frame) do
      {:ok, state} ->
        Simulator.Stats.bump(:sent)
        bump_ref(state)

      {:error, _} ->
        Simulator.Stats.bump(:send_errors)
        bump_ref(state)
    end
  end

  defp ws_send(state, frame) do
    case WS.encode(state.ws, {:text, frame}) do
      {:ok, ws, data} ->
        case WS.stream_request_body(state.conn, state.ref, data) do
          {:ok, conn} -> {:ok, %{state | ws: ws, conn: conn}}
          {:error, _conn, reason} -> {:error, reason}
        end

      {:error, _ws, reason} ->
        {:error, reason}
    end
  end

  defp handle_ws_responses(responses, state) do
    Enum.reduce(responses, state, fn
      {:data, _ref, data}, acc ->
        case WS.decode(acc.ws, data) do
          {:ok, ws, frames} ->
            Enum.each(frames, fn
              {:text, _} -> Simulator.Stats.bump(:received)
              _ -> :ok
            end)

            %{acc | ws: ws}

          _ ->
            acc
        end

      _, acc ->
        acc
    end)
  end

  defp phoenix_frame(join_ref, ref, topic, event, payload) do
    Jason.encode!([join_ref, ref, topic, event, payload])
  end

  defp ref(state), do: Integer.to_string(state.next_ref)
  defp bump_ref(state), do: %{state | next_ref: state.next_ref + 1}

  defp schedule_next_send(%{msgs_per_sec: 0}), do: :ok

  defp schedule_next_send(%{msgs_per_sec: mps}) do
    interval_ms = max(div(1_000, max(mps, 1)), 1)
    # Add jitter so clients don't fire in lockstep
    jitter = :rand.uniform(interval_ms + 1) - 1
    Process.send_after(self(), :send_tick, interval_ms + jitter)
  end

  defp schedule_shutdown(%{end_at: end_at}) do
    delay = max(end_at - System.monotonic_time(:millisecond), 0)
    Process.send_after(self(), :shutdown, delay)
  end

  defp pad(s, size) when byte_size(s) >= size, do: binary_part(s, 0, size)
  defp pad(s, size), do: s <> String.duplicate(".", size - byte_size(s))
end
