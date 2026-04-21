defmodule Eir.Latency do
  @moduledoc """
  Simple per-node latency histogram with log-bucketed sampling.

  We track two spans:
    - broadcast: ingest → PubSub broadcast call returns
    - persist:   ingest → Postgres insert confirmation

  Buckets are microseconds, power-of-2: 64, 128, ..., 8_388_608 (~8s).
  Counters live in ETS so instrument sites don't contend with each other.
  """

  @table :eir_latency
  @buckets Enum.map(6..23, fn pow -> :math.pow(2, pow) |> trunc() end)

  def bucket_edges, do: @buckets

  def init do
    case :ets.whereis(@table) do
      :undefined ->
        :ets.new(@table, [:set, :public, :named_table, write_concurrency: true])

      _ ->
        :ok
    end

    for kind <- [:broadcast, :persist],
        b <- @buckets,
        do: :ets.insert(@table, {{kind, b}, 0})

    for kind <- [:broadcast, :persist] do
      :ets.insert(@table, {{kind, :count}, 0})
      :ets.insert(@table, {{kind, :sum_us}, 0})
      :ets.insert(@table, {{kind, :max_us}, 0})
    end

    :ok
  end

  @doc """
  Record an observation. `kind` is `:broadcast` or `:persist`; `us` is the
  duration in microseconds (System.monotonic_time(:microsecond) math).
  """
  def observe(kind, us) when is_integer(us) and us > 0 do
    b = bucket(us)
    :ets.update_counter(@table, {kind, b}, {2, 1}, {{kind, b}, 0})
    :ets.update_counter(@table, {kind, :count}, {2, 1}, {{kind, :count}, 0})
    :ets.update_counter(@table, {kind, :sum_us}, {2, us}, {{kind, :sum_us}, 0})

    # Max is racy but close enough
    case :ets.lookup(@table, {kind, :max_us}) do
      [{_, m}] when us > m -> :ets.insert(@table, {{kind, :max_us}, us})
      _ -> :ok
    end

    :ok
  end

  def observe(_kind, _us), do: :ok

  @doc "Reset all counters — called on cluster-wide reset."
  def reset do
    for kind <- [:broadcast, :persist], b <- @buckets do
      :ets.insert(@table, {{kind, b}, 0})
    end

    for kind <- [:broadcast, :persist] do
      :ets.insert(@table, {{kind, :count}, 0})
      :ets.insert(@table, {{kind, :sum_us}, 0})
      :ets.insert(@table, {{kind, :max_us}, 0})
    end
  end

  @doc """
  Returns a histogram snapshot for the given kind. Shape:
  `%{buckets: [%{le_us: n, count: n}], count: n, p50_us: n, p99_us: n, p999_us: n, max_us: n, mean_us: float}`
  """
  def snapshot(kind) do
    counts =
      Enum.map(@buckets, fn b ->
        case :ets.lookup(@table, {kind, b}) do
          [{_, c}] -> {b, c}
          [] -> {b, 0}
        end
      end)

    total = Enum.reduce(counts, 0, fn {_, c}, a -> a + c end)

    percentile = fn p ->
      target = total * p / 100
      {le, _} =
        Enum.reduce_while(counts, {0, 0.0}, fn {b, c}, {_, running} ->
          running = running + c
          if running >= target, do: {:halt, {b, running}}, else: {:cont, {b, running}}
        end)

      le
    end

    sum_us = read_counter(kind, :sum_us)
    max_us = read_counter(kind, :max_us)

    mean = if total > 0, do: Float.round(sum_us / total, 1), else: 0.0

    %{
      buckets: Enum.map(counts, fn {b, c} -> %{le_us: b, count: c} end),
      count: total,
      p50_us: if(total > 0, do: percentile.(50), else: 0),
      p99_us: if(total > 0, do: percentile.(99), else: 0),
      p999_us: if(total > 0, do: percentile.(99.9), else: 0),
      max_us: max_us,
      mean_us: mean
    }
  end

  defp read_counter(kind, field) do
    case :ets.lookup(@table, {kind, field}) do
      [{_, v}] -> v
      [] -> 0
    end
  end

  defp bucket(us) do
    # returns the smallest bucket edge >= us
    Enum.find(@buckets, List.last(@buckets), fn b -> b >= us end)
  end
end
