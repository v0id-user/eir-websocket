defmodule Eir.Metrics do
  @moduledoc """
  Aggregates hot-path telemetry into counters, samples them every 100ms,
  and broadcasts a snapshot on `metrics:live` for the dashboard.

  Counters live in an ETS table so telemetry handlers are lock-free.
  """

  use GenServer

  @table :eir_metrics
  @tick_ms 100
  @pubsub Eir.PubSub

  # Keys we count
  @counters [
    :ingest_received,
    :batch_persisted,
    :channel_joined,
    :channel_left,
    :sim_tick
  ]

  # Public ----------------------------------------------------------------

  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  def bump(counter, n \\ 1) when counter in @counters do
    :ets.update_counter(@table, counter, {2, n}, {counter, 0})
  end

  def snapshot do
    counters =
      Enum.into(@counters, %{}, fn k ->
        val =
          case :ets.lookup(@table, k) do
            [{^k, v}] -> v
            [] -> 0
          end

        {k, val}
      end)

    rates =
      case :ets.lookup(@table, :rates) do
        [{:rates, r}] -> r
        [] -> %{}
      end

    %{
      node: to_string(node()),
      cluster: Enum.map([node() | Node.list()], &to_string/1),
      at_ms: System.system_time(:millisecond),
      counters: counters,
      rates: rates,
      cache: %{
        groups: cache_groups(),
        total: Eir.Chat.Cache.total_count()
      },
      pipeline: %{
        queue_depth: Eir.Chat.Pipeline.queue_depth()
      },
      system: system_metrics(),
      connections: connection_count()
    }
  end

  defp cache_groups do
    :ets.tab2list(:eir_chat_cache_counts)
    |> Enum.into(%{}, fn {gid, count} -> {gid, count} end)
  end

  defp connection_count do
    # Phoenix channel processes — proxy via ETS counter we maintain
    case :ets.lookup(@table, :connections) do
      [{:connections, n}] -> n
      [] -> 0
    end
  end

  defp system_metrics do
    mem = :erlang.memory()
    {{:input, input}, {:output, output}} = :erlang.statistics(:io)
    {total_reds, _} = :erlang.statistics(:reductions)
    {ms, _} = :erlang.statistics(:wall_clock)

    %{
      processes: :erlang.system_info(:process_count),
      processes_limit: :erlang.system_info(:process_limit),
      ports: :erlang.system_info(:port_count),
      ports_limit: :erlang.system_info(:port_limit),
      atoms: :erlang.system_info(:atom_count),
      atoms_limit: :erlang.system_info(:atom_limit),
      ets_tables: :erlang.system_info(:ets_count),
      memory_mb: Float.round(mem[:total] / 1_048_576, 1),
      memory_processes_mb: Float.round(mem[:processes] / 1_048_576, 1),
      memory_binary_mb: Float.round(mem[:binary] / 1_048_576, 1),
      memory_ets_mb: Float.round(mem[:ets] / 1_048_576, 1),
      memory_code_mb: Float.round(mem[:code] / 1_048_576, 1),
      schedulers: :erlang.system_info(:schedulers_online),
      run_queue: :erlang.statistics(:total_run_queue_lengths_all),
      reductions_total: total_reds,
      io_in_mb: Float.round(input / 1_048_576, 1),
      io_out_mb: Float.round(output / 1_048_576, 1),
      uptime_s: div(ms, 1000)
    }
  end

  # GenServer -------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [:set, :public, :named_table, write_concurrency: true])

    for k <- @counters, do: :ets.insert(@table, {k, 0})
    :ets.insert(@table, {:connections, 0})
    :ets.insert(@table, {:rates, %{}})

    attach_telemetry()

    Phoenix.PubSub.subscribe(@pubsub, "eir:reset")
    :timer.send_interval(@tick_ms, :tick)

    {:reds, prev_reds} = :erlang.statistics(:reductions)

    {:ok,
     %{
       prev: now_counters(),
       prev_at: System.monotonic_time(:millisecond),
       prev_reds: prev_reds
     }}
  end

  @impl true
  def handle_info(:tick, state) do
    now_at = System.monotonic_time(:millisecond)
    dt = max(now_at - state.prev_at, 1)
    curr = now_counters()

    {total_reds, _} = :erlang.statistics(:reductions)
    reds_delta = max(total_reds - state.prev_reds, 0)
    reds_per_sec = reds_delta * 1000 / dt

    rates =
      for {k, v} <- curr, into: %{} do
        delta = v - Map.get(state.prev, k, 0)
        {k, Float.round(delta * 1000 / dt, 1)}
      end

    rates = Map.put(rates, :reductions, Float.round(reds_per_sec, 0))

    :ets.insert(@table, {:rates, rates})

    snap = snapshot()
    Phoenix.PubSub.broadcast!(@pubsub, "metrics:live", {:metrics_tick, snap})

    {:noreply, %{state | prev: curr, prev_at: now_at, prev_reds: total_reds}}
  end

  @impl true
  def handle_info(:reset_local, state) do
    for k <- @counters, do: :ets.insert(@table, {k, 0})
    :ets.insert(@table, {:connections, 0})
    :ets.insert(@table, {:rates, %{}})
    {:noreply, %{state | prev: now_counters(), prev_at: System.monotonic_time(:millisecond)}}
  end

  defp now_counters do
    Enum.into(@counters, %{}, fn k ->
      case :ets.lookup(@table, k) do
        [{^k, v}] -> {k, v}
        [] -> {k, 0}
      end
    end)
  end

  defp attach_telemetry do
    events = [
      {[:eir, :ingest, :received], :ingest_received},
      {[:eir, :pipeline, :batch_persisted], :batch_persisted},
      {[:eir, :channel, :joined], :channel_joined},
      {[:eir, :channel, :left], :channel_left}
    ]

    for {event, counter} <- events do
      :telemetry.attach(
        "eir-metrics-#{Enum.join(event, "-")}",
        event,
        fn _event, measurements, metadata, _ ->
          n = measurements[:count] || 1
          bump_event(counter, n, metadata)
        end,
        nil
      )
    end
  end

  defp bump_event(:channel_joined, n, _) do
    bump(:channel_joined, n)
    :ets.update_counter(@table, :connections, {2, n}, {:connections, 0})
  end

  defp bump_event(:channel_left, n, _) do
    bump(:channel_left, n)
    :ets.update_counter(@table, :connections, {2, -n}, {:connections, 0})
  end

  defp bump_event(counter, n, _), do: bump(counter, n)
end
