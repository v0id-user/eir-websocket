defmodule Eir.Chat.Cache do
  @moduledoc """
  In-memory ring buffer per group, backed by a single ordered_set ETS table.

  Key layout: `{group_id, id_bin}` — `ordered_set` gives us range scans with
  `:ets.select/2` + `$end_of_table` bookmarks for cursor pagination.

  Each group keeps up to `@max_per_group` most-recent messages; older ones are
  trimmed lazily on insert. Cache is per-node; a cross-node read that misses
  falls through to the DB.
  """

  use GenServer

  @table :eir_chat_cache
  @counts :eir_chat_cache_counts
  @max_per_group 200

  # Public API ------------------------------------------------------------

  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc "Insert a message. Safe from any process — hot path, no GenServer call."
  def put(%Eir.Chat.Message{} = m) do
    :ets.insert(@table, {{m.group_id, m.id}, m})
    count = :ets.update_counter(@counts, m.group_id, {2, 1}, {m.group_id, 0})

    if count > @max_per_group * 2 do
      # defer the trim so hot path stays O(1)
      GenServer.cast(__MODULE__, {:trim, m.group_id})
    end

    :ok
  end

  @doc """
  Fetch up to `limit` messages for `group_id` older than `before_id` (string or bin).
  `before_id: nil` means "give me the latest". Returns oldest→newest.
  Returns `{:ok, messages}` on cache hit, `:miss` if the group isn't cached.
  """
  def fetch(group_id, before_id, limit) when limit > 0 do
    case :ets.member(@counts, group_id) do
      false ->
        :miss

      true ->
        pivot = normalize_pivot(before_id)

        # ordered_set traversed in descending key order
        matches = select_desc(group_id, pivot, limit)
        {:ok, Enum.reverse(matches)}
    end
  end

  def count(group_id) do
    case :ets.lookup(@counts, group_id) do
      [{^group_id, n}] -> n
      [] -> 0
    end
  end

  def total_count do
    :ets.foldl(fn {_, n}, acc -> acc + n end, 0, @counts)
  end

  def reset do
    :ets.delete_all_objects(@table)
    :ets.delete_all_objects(@counts)
    :ok
  end

  # GenServer -------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [:ordered_set, :public, :named_table, read_concurrency: true, write_concurrency: true])
    :ets.new(@counts, [:set, :public, :named_table, write_concurrency: true])
    Phoenix.PubSub.subscribe(Eir.PubSub, "eir:reset")
    {:ok, %{}}
  end

  @impl true
  def handle_cast({:trim, group_id}, state) do
    trim(group_id)
    {:noreply, state}
  end

  @impl true
  def handle_info(:reset_local, state) do
    :ets.delete_all_objects(@table)
    :ets.delete_all_objects(@counts)
    {:noreply, state}
  end

  # Internal --------------------------------------------------------------

  defp normalize_pivot(nil), do: :latest
  defp normalize_pivot(<<_::binary-size(16)>> = bin), do: bin
  defp normalize_pivot(<<_::binary-size(36)>> = s), do: Eir.ID.string_to_bin(s)

  defp select_desc(group_id, :latest, limit) do
    select_desc_from(group_id, :"$end_of_table", limit, [])
  end

  defp select_desc(group_id, pivot_bin, limit) do
    # With {group_id, id} keys in an ordered_set, every group's keys are
    # contiguous. :ets.prev({group_id, pivot}) returns the largest key
    # less than that. If it's in a different group, there are zero keys
    # in group_id lower than the pivot, so the correct answer is [].
    case :ets.prev(@table, {group_id, pivot_bin}) do
      {^group_id, _} = key -> walk_desc(key, group_id, limit, [])
      _ -> []
    end
  end

  defp select_desc_from(group_id, :"$end_of_table", limit, acc) do
    case :ets.last(@table) do
      :"$end_of_table" -> acc
      {^group_id, _} = key -> walk_desc(key, group_id, limit, acc)
      other_key -> seek_back(other_key, group_id, limit, acc)
    end
  end

  defp seek_back(key, group_id, limit, acc) do
    case :ets.prev(@table, key) do
      :"$end_of_table" -> acc
      {^group_id, _} = k -> walk_desc(k, group_id, limit, acc)
      k -> seek_back(k, group_id, limit, acc)
    end
  end

  defp walk_desc(_key, _group_id, 0, acc), do: acc

  defp walk_desc({group_id, _} = key, group_id, limit, acc) do
    [{^key, msg}] = :ets.lookup(@table, key)
    next_acc = [msg | acc]

    case :ets.prev(@table, key) do
      :"$end_of_table" -> next_acc
      {^group_id, _} = next_key -> walk_desc(next_key, group_id, limit - 1, next_acc)
      _ -> next_acc
    end
  end

  defp walk_desc(_, _, _, acc), do: acc

  defp trim(group_id) do
    case :ets.lookup(@counts, group_id) do
      [{^group_id, n}] when n > @max_per_group ->
        to_drop = n - @max_per_group
        keys_to_delete = oldest_keys(group_id, to_drop)

        Enum.each(keys_to_delete, &:ets.delete(@table, &1))
        :ets.update_counter(@counts, group_id, {2, -length(keys_to_delete)})

      _ ->
        :ok
    end
  end

  defp oldest_keys(group_id, n) do
    match_spec = [
      {{{group_id, :"$1"}, :_}, [], [{{group_id, :"$1"}}]}
    ]

    case :ets.select(@table, match_spec, n) do
      {rows, _cont} -> rows
      :"$end_of_table" -> []
    end
  end
end
