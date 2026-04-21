defmodule EirWeb.GroupChannel do
  use Phoenix.Channel

  alias Eir.Chat

  @impl true
  def join("group:" <> group_id, _params, socket) do
    Phoenix.PubSub.subscribe(Eir.PubSub, "group:" <> group_id)

    {source, wire_messages} = Chat.history(group_id, nil, 50)
    send(self(), :after_join)

    {:ok, %{messages: wire_messages, source: source, node: to_string(node())},
     assign(socket, :group_id, group_id)}
  end

  @impl true
  def handle_in("send", %{"body" => body} = params, socket) do
    author =
      case params["nickname"] do
        n when is_binary(n) and n != "" -> n
        _ -> socket.assigns.nickname
      end

    Chat.ingest(%{
      group_id: socket.assigns.group_id,
      author: author,
      body: body,
      reply_to_id: params["reply_to_id"]
    })

    {:reply, :ok, socket}
  end

  @impl true
  def handle_info({:chat_message, wire}, socket) do
    push(socket, "message", wire)
    {:noreply, socket}
  end

  def handle_info(%Phoenix.Socket.Broadcast{event: "presence_diff", payload: payload}, socket) do
    push(socket, "presence_diff", payload)
    {:noreply, socket}
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
  def terminate(_reason, socket) do
    if socket.assigns[:group_id] do
      :telemetry.execute([:eir, :channel, :left], %{count: 1}, %{
        group_id: socket.assigns.group_id
      })
    end

    :ok
  end
end
