defmodule Eir.Chat do
  @moduledoc """
  The public API for chat ingest and history.

  Hot path (`ingest/1`) is what every incoming message hits:
    1. build message with UUIDv7
    2. put in node-local ETS cache (O(1))
    3. broadcast on Phoenix.PubSub (distributed — reaches subscribers on any node)
    4. push to Broadway pipeline for batched DB insert
    5. emit telemetry for the metrics dashboard
  """

  alias Eir.Chat.{Cache, Message, Pipeline}
  alias Phoenix.PubSub

  import Ecto.Query
  require Logger

  @pubsub Eir.PubSub

  @presets %{
    groups: ["general", "random", "music", "gaming", "tech", "dev", "memes", "news"],
    authors: [
      "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
      "ivan", "judy", "mallory", "oscar", "peggy", "trent", "victor", "wendy"
    ]
  }

  def presets, do: @presets

  @doc "The hot path. Call this with the message attrs — returns the built message."
  def ingest(%{group_id: _, author: _, body: _} = attrs) do
    msg = Message.new(attrs)

    :telemetry.execute([:eir, :ingest, :received], %{count: 1}, %{group_id: msg.group_id})

    # 1. local cache — O(1), no blocking
    Cache.put(msg)

    # 2. distributed fan-out
    wire = Message.to_wire(msg)
    PubSub.broadcast!(@pubsub, "group:" <> msg.group_id, {:chat_message, wire})
    PubSub.broadcast!(@pubsub, "firehose", {:chat_message, wire})

    # 3. async persistence
    Pipeline.push(msg)

    msg
  end

  @doc """
  Fetch recent messages for a group. Cache-first, falls back to DB.
  `before_id` — cursor; nil = latest page.
  """
  def history(group_id, before_id \\ nil, limit \\ 50) do
    case Cache.fetch(group_id, before_id, limit) do
      {:ok, messages} when length(messages) >= limit ->
        {:cache, Enum.map(messages, &Message.to_wire/1)}

      {:ok, messages} ->
        # partial cache hit — top up from DB
        extra_before =
          case messages do
            [oldest | _] -> oldest.id
            [] -> before_id
          end

        needed = limit - length(messages)
        db_msgs = history_db(group_id, extra_before, needed)

        {:mixed,
         Enum.map(db_msgs ++ messages, &Message.to_wire/1)}

      :miss ->
        {:db, history_db(group_id, before_id, limit) |> Enum.map(&Message.to_wire/1)}
    end
  end

  defp history_db(group_id, before_id, limit) do
    # Ecto :binary_id accepts canonical string form in queries
    pivot =
      case before_id do
        nil -> nil
        <<_::binary-size(16)>> = b -> Eir.ID.bin_to_string(b)
        <<_::binary-size(36)>> = s -> s
      end

    base =
      from m in Message,
        where: m.group_id == ^group_id,
        order_by: [desc: m.id],
        limit: ^limit

    query = if pivot, do: from(m in base, where: m.id < ^pivot), else: base

    Eir.Repo.all(query) |> Enum.reverse()
  end

  @doc "Wipe everything — DB + cache. Used between test runs."
  def reset_all do
    Eir.Repo.delete_all(Message)
    Cache.reset()
    PubSub.broadcast!(@pubsub, "firehose", {:chat_reset, %{at: DateTime.utc_now()}})
    :ok
  end
end
