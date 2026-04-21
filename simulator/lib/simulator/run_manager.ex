defmodule Simulator.RunManager do
  @moduledoc """
  Orchestrates a load run: spawns N `Simulator.Client` workers into a
  DynamicSupervisor, spreads them across the configured groups, enforces
  a duration, and cleans up.

  Only one run at a time (keeps the $5 Railway plan from melting).
  """

  use GenServer

  @default_groups ["general", "random", "music", "gaming", "tech", "dev", "memes", "news"]
  @default_authors ~w(alice bob carol dave erin frank grace heidi ivan judy mallory oscar)

  def start_link(_), do: GenServer.start_link(__MODULE__, %{run: nil}, name: __MODULE__)

  def start_run(params), do: GenServer.call(__MODULE__, {:start, params}, 10_000)
  def stop_run, do: GenServer.call(__MODULE__, :stop)
  def current_run, do: GenServer.call(__MODULE__, :current)

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:start, params}, _from, %{run: nil} = state) do
    target = params["target"] || raise "target required (ws://host/socket/websocket)"
    connections = clamp(params["connections"] || 100, 1, 10_000)
    msgs_per_sec = clamp(params["msgs_per_sec"] || 1, 0, 500)
    duration = clamp(params["duration"] || 30, 1, 600)
    groups = params["groups"] || @default_groups
    authors = params["authors"] || @default_authors
    body_size = clamp(params["body_size"] || 64, 8, 1024)

    Simulator.Stats.reset()

    started_at = System.monotonic_time(:millisecond)
    end_at = started_at + duration * 1000

    run_info = %{
      id: :erlang.unique_integer([:positive]),
      target: target,
      connections: connections,
      msgs_per_sec: msgs_per_sec,
      duration: duration,
      groups: groups,
      body_size: body_size,
      started_ms: System.system_time(:millisecond),
      end_ms: System.system_time(:millisecond) + duration * 1000
    }

    Simulator.Stats.set_run(run_info)

    # Spawn clients with small stagger so we don't hammer the target at once
    Enum.each(0..(connections - 1), fn i ->
      group = Enum.at(groups, rem(i, length(groups)))
      author = Enum.at(authors, rem(i, length(authors))) <> "-" <> Integer.to_string(i)

      DynamicSupervisor.start_child(
        Simulator.ClientSup,
        {Simulator.Client,
         [
           id: i,
           target: target,
           group: group,
           author: author,
           msgs_per_sec: msgs_per_sec,
           body_size: body_size,
           end_at: end_at
         ]}
      )

      # spread ramp-up over 1s to avoid thundering herd
      if rem(i, max(div(connections, 50), 1)) == 0, do: Process.sleep(20)
    end)

    Process.send_after(self(), :finalize, duration * 1000 + 2000)

    {:reply, {:ok, run_info}, %{state | run: run_info}}
  end

  def handle_call({:start, _}, _from, state) do
    {:reply, {:error, :already_running}, state}
  end

  def handle_call(:stop, _from, state) do
    shut_down_clients()
    Simulator.Stats.clear_run()
    {:reply, :ok, %{state | run: nil}}
  end

  def handle_call(:current, _from, state) do
    {:reply, state.run, state}
  end

  @impl true
  def handle_info(:finalize, state) do
    shut_down_clients()
    Simulator.Stats.clear_run()
    {:noreply, %{state | run: nil}}
  end

  defp shut_down_clients do
    DynamicSupervisor.which_children(Simulator.ClientSup)
    |> Enum.each(fn {_, pid, _, _} ->
      DynamicSupervisor.terminate_child(Simulator.ClientSup, pid)
    end)
  end

  defp clamp(val, lo, hi) when is_integer(val) do
    val |> Kernel.max(lo) |> Kernel.min(hi)
  end

  defp clamp(val, lo, hi), do: clamp(to_int(val), lo, hi)

  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: trunc(v)
  defp to_int(v) when is_binary(v) do
    case Integer.parse(v) do
      {n, _} -> n
      :error -> 0
    end
  end
end
