defmodule EirWeb.GroupChannel do
  use Phoenix.Channel

  alias Eir.Chat

  @max_nickname_bytes 64
  @max_body_bytes 2_000

  # Phoenix 1.8 routes Broadcasts through handle_out when a default override
  # is installed by Phoenix.Channel. We intercept presence_diff explicitly so
  # our handle_out runs. Non-intercepted events fastlane straight to the socket.
  intercept ["presence_diff"]

  @impl true
  def join("group:" <> group_id, _params, socket) do
    # Phoenix.Channel.Server auto-subscribes the channel process to its topic.
    # Don't subscribe manually — that would double-deliver every message.

    {source, wire_messages} = Chat.history(group_id, nil, 50)
    send(self(), :after_join)

    {:ok, %{messages: wire_messages, source: source, node: to_string(node())},
     assign(socket, :group_id, group_id)}
  end

  @impl true
  def handle_in("send", %{"body" => body} = params, socket) when is_binary(body) do
    if byte_size(body) > @max_body_bytes do
      {:reply, {:error, %{reason: "body_too_large"}}, socket}
    else
      author = pick_author(params, socket)

      Chat.ingest(%{
        group_id: socket.assigns.group_id,
        author: author,
        body: body,
        reply_to_id: params["reply_to_id"]
      })

      {:reply, :ok, socket}
    end
  end

  def handle_in("set_nick", %{"nickname" => raw}, socket) when is_binary(raw) do
    case trimmed_nick(raw) do
      "" ->
        {:reply, {:error, %{reason: "empty"}}, socket}

      new_nick ->
        # Untrack our old presence entry and re-track with the new name so
        # everyone sees the change. Leaves metadata under the old key; the
        # Presence CRDT propagates the swap to all nodes.
        old = socket.assigns.nickname
        topic = "group:" <> socket.assigns.group_id
        Eir.Presence.untrack(self(), topic, old)

        {:ok, _} =
          Eir.Presence.track(self(), topic, new_nick, %{
            online_at: System.system_time(:second),
            node: to_string(node())
          })

        {:reply, :ok, assign(socket, :nickname, new_nick)}
    end
  end

  defp pick_author(params, socket) do
    case trimmed_nick(params["nickname"]) do
      "" -> socket.assigns.nickname
      n -> n
    end
  end

  defp trimmed_nick(n) when is_binary(n) do
    trimmed = String.trim(n)

    cond do
      trimmed == "" -> ""
      byte_size(trimmed) > @max_nickname_bytes -> binary_part(trimmed, 0, @max_nickname_bytes)
      true -> trimmed
    end
  end

  defp trimmed_nick(_), do: ""

  # If this channel's mailbox is more than this behind, we drop broadcasts
  # rather than pile them up unboundedly. Otherwise a slow browser anywhere
  # in the cluster can pin hundreds of MBs of RAM across the channel process.
  @max_mailbox_for_broadcast 500

  @impl true
  def handle_info({:chat_message, wire}, socket) do
    case Process.info(self(), :message_queue_len) do
      {:message_queue_len, n} when n > @max_mailbox_for_broadcast ->
        # Drop — client is too far behind. They'll catch up on reload via
        # history API.
        :telemetry.execute([:eir, :channel, :dropped], %{count: 1}, %{queue_len: n})
        {:noreply, socket}

      _ ->
        push(socket, "message", wire)
        {:noreply, socket}
    end
  end

  def handle_info(:after_join, socket) do
    :telemetry.execute([:eir, :channel, :joined], %{count: 1}, %{
      group_id: socket.assigns.group_id
    })

    {:ok, _} =
      Eir.Presence.track(self(), "group:" <> socket.assigns.group_id, socket.assigns.nickname, %{
        online_at: System.system_time(:second),
        node: to_string(node())
      })

    push(socket, "presence_state", Eir.Presence.list("group:" <> socket.assigns.group_id))
    {:noreply, socket}
  end

  @impl true
  def handle_out("presence_diff", payload, socket) do
    push(socket, "presence_diff", payload)
    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, socket) do
    if socket.assigns[:group_id] do
      :telemetry.execute([:eir, :channel, :left], %{count: 1}, %{
        group_id: socket.assigns.group_id
      })
    end

    :ok
  end
end
