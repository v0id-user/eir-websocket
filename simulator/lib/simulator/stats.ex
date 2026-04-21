defmodule Simulator.Stats do
  @moduledoc """
  Aggregate counters for the active simulator run. Lock-free ETS.
  """

  use GenServer

  @table :sim_stats
  @counters [
    :connected,
    :disconnected,
    :sent,
    :send_errors,
    :received
  ]

  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  def bump(counter, n \\ 1) when counter in @counters do
    :ets.update_counter(@table, counter, {2, n}, {counter, 0})
  end

  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  def snapshot do
    counters =
      Enum.into(@counters, %{}, fn k ->
        v =
          case :ets.lookup(@table, k) do
            [{^k, n}] -> n
            [] -> 0
          end

        {k, v}
      end)

    rates =
      case :ets.lookup(@table, :rates) do
        [{:rates, r}] -> r
        [] -> %{}
      end

    run =
      case :ets.lookup(@table, :run) do
        [{:run, r}] -> r
        [] -> nil
      end

    %{
      counters: counters,
      rates: rates,
      run: run,
      node: to_string(node()),
      at_ms: System.system_time(:millisecond)
    }
  end

  def set_run(info) do
    :ets.insert(@table, {:run, info})
  end

  def clear_run do
    :ets.delete(@table, :run)
  end

  @impl true
  def init(_) do
    :ets.new(@table, [:set, :public, :named_table, write_concurrency: true])
    for k <- @counters, do: :ets.insert(@table, {k, 0})
    :ets.insert(@table, {:rates, %{}})

    :timer.send_interval(100, :tick)
    {:ok, %{prev: zero_counters(), prev_at: System.monotonic_time(:millisecond)}}
  end

  @impl true
  def handle_call(:reset, _from, state) do
    for k <- @counters, do: :ets.insert(@table, {k, 0})
    :ets.insert(@table, {:rates, %{}})
    {:reply, :ok, %{state | prev: zero_counters(), prev_at: System.monotonic_time(:millisecond)}}
  end

  @impl true
  def handle_info(:tick, state) do
    now_at = System.monotonic_time(:millisecond)
    dt = max(now_at - state.prev_at, 1)

    curr =
      Enum.into(@counters, %{}, fn k ->
        [{^k, v}] = :ets.lookup(@table, k)
        {k, v}
      end)

    rates =
      for {k, v} <- curr, into: %{} do
        delta = v - Map.get(state.prev, k, 0)
        {k, Float.round(delta * 1000 / dt, 1)}
      end

    :ets.insert(@table, {:rates, rates})
    {:noreply, %{state | prev: curr, prev_at: now_at}}
  end

  defp zero_counters, do: Enum.into(@counters, %{}, &{&1, 0})
end
