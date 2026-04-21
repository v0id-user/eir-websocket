defmodule EirWeb.MetricsChannel do
  @moduledoc """
  Live metrics channel. Maintains a per-node count of subscribers in an ETS
  counter so the Eir.Metrics GenServer can skip broadcasts when nobody is
  watching — that's the difference between an idle service and one that
  spends 13Hz worth of CPU + outbound bandwidth doing nothing useful.
  """

  use Phoenix.Channel

  @counter_table :eir_metrics_subscribers

  @doc "Initializes the subscriber-count table. Called once from Eir.Metrics.init/1."
  def init_subscriber_table do
    case :ets.whereis(@counter_table) do
      :undefined ->
        :ets.new(@counter_table, [:set, :public, :named_table, write_concurrency: true])
        :ets.insert(@counter_table, {:n, 0})

      _ ->
        :ok
    end
  end

  @doc "Returns true if any client is currently subscribed on this node."
  def has_subscribers? do
    case :ets.whereis(@counter_table) do
      :undefined ->
        false

      _ ->
        case :ets.lookup(@counter_table, :n) do
          [{:n, n}] -> n > 0
          _ -> false
        end
    end
  end

  @impl true
  def join("metrics:live", _params, socket) do
    Phoenix.PubSub.subscribe(Eir.PubSub, "metrics:live")
    bump_subscribers(1)
    send(self(), :push_snapshot)
    {:ok, socket}
  end

  @impl true
  def handle_info(:push_snapshot, socket) do
    push(socket, "snapshot", Eir.Metrics.snapshot())
    {:noreply, socket}
  end

  def handle_info({:metrics_tick, payload}, socket) do
    push(socket, "tick", payload)
    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, _socket) do
    bump_subscribers(-1)
    :ok
  end

  defp bump_subscribers(delta) do
    case :ets.whereis(@counter_table) do
      :undefined -> :ok
      _ -> :ets.update_counter(@counter_table, :n, {2, delta}, {:n, 0})
    end
  end
end
