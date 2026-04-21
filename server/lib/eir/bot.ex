defmodule Eir.Bot do
  @moduledoc """
  A chat participant. Subscribes to every group's PubSub topic, watches for
  @bot mentions, and posts a reply through the same Chat.ingest/1 hot path
  every other user goes through.

  Uses Claude if ANTHROPIC_API_KEY is set; otherwise uses scripted fallbacks
  so the demo still works cold.

  Running on ONE node of the cluster is enough because Phoenix.PubSub is
  distributed — the bot hears every message regardless of which node
  originated it. We keep it simple with a global name so only one bot
  process exists cluster-wide.
  """

  use GenServer
  require Logger

  @bot_nick "bot"
  @anthropic_model "claude-sonnet-4-5"
  @max_reply_chars 400

  # Each node starts its own bot. Only the node that is the current "leader"
  # (lowest node name in the sorted cluster) actually replies, so we don't
  # duplicate responses across the cluster. Leader election is recomputed
  # on every message — zero coordination cost.
  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    # subscribe once per preset group; newly-dynamic groups aren't covered
    # (we have a fixed preset in this demo)
    for g <- Eir.Chat.presets().groups do
      Phoenix.PubSub.subscribe(Eir.PubSub, "group:" <> g)
    end

    state = %{
      api_key: System.get_env("ANTHROPIC_API_KEY"),
      # in-flight rate limiting: max 1 request at a time
      busy?: false
    }

    {:ok, state}
  end

  @impl true
  def handle_info({:chat_message, msg}, state) do
    if should_respond?(msg, state) do
      spawn_reply(msg, state)
      {:noreply, %{state | busy?: true}}
    else
      {:noreply, state}
    end
  end

  def handle_info({:reply_done, _}, state) do
    {:noreply, %{state | busy?: false}}
  end

  def handle_info(_, state), do: {:noreply, state}

  # ----

  defp should_respond?(%{author: @bot_nick}, _), do: false
  defp should_respond?(_, %{busy?: true}), do: false

  defp should_respond?(%{body: body}, _state) do
    String.contains?(String.downcase(body), "@bot") and is_leader?()
  end

  defp is_leader? do
    [leader | _] = [node() | Node.list()] |> Enum.sort()
    leader == node()
  end

  defp spawn_reply(msg, state) do
    parent = self()
    api_key = state.api_key
    group_id = msg.group_id
    msg_id = msg.id
    prompt = msg.body

    Task.start(fn ->
      reply =
        case api_key do
          key when is_binary(key) and byte_size(key) > 0 ->
            ask_claude(prompt, key) || canned(prompt)

          _ ->
            canned(prompt)
        end

      if is_binary(reply) and reply != "" do
        Eir.Chat.ingest(%{
          group_id: group_id,
          author: @bot_nick,
          body: truncate(reply, @max_reply_chars),
          reply_to_id: msg_id
        })
      end

      send(parent, {:reply_done, msg_id})
    end)
  end

  defp ask_claude(prompt, api_key) do
    body =
      Jason.encode!(%{
        model: @anthropic_model,
        max_tokens: 300,
        system:
          "You are a terse chat bot in a stress-test chatroom. " <>
            "Keep replies under 2 sentences, no emojis, lowercase, match the room's irc-ish tone.",
        messages: [%{role: "user", content: prompt}]
      })

    headers = [
      {~c"x-api-key", String.to_charlist(api_key)},
      {~c"anthropic-version", ~c"2023-06-01"},
      {~c"content-type", ~c"application/json"}
    ]

    request = {~c"https://api.anthropic.com/v1/messages", headers, ~c"application/json", body}

    case :httpc.request(:post, request, [{:timeout, 15_000}], []) do
      {:ok, {{_, 200, _}, _hdrs, resp_body}} ->
        case Jason.decode(IO.iodata_to_binary(resp_body)) do
          {:ok, %{"content" => [%{"text" => text} | _]}} -> text
          _ -> nil
        end

      other ->
        Logger.warning("bot http error: #{inspect(other)}")
        nil
    end
  rescue
    e ->
      Logger.warning("bot crash: #{Exception.message(e)}")
      nil
  end

  @canned [
    "beep boop. broadway is batching behind the scenes.",
    "all four replicas are listening. say hi anywhere, hear it everywhere.",
    "i'm a genserver. my mailbox is rarely empty.",
    "try /me or kill a node from the dashboard, it's fine.",
    "ets is faster than your feelings.",
    "phoenix.pubsub just handed your message to everyone subscribed on every node. no questions asked."
  ]

  defp canned(prompt) do
    cond do
      String.contains?(prompt, "stats") -> "check /dashboard for the live picture."
      String.contains?(prompt, "cluster") -> "four beam nodes, each in its own container, meshed over ipv6 via dns_cluster."
      String.contains?(prompt, "why") -> "because the beam can, that's why."
      true -> Enum.random(@canned)
    end
  end

  defp truncate(s, n) when byte_size(s) <= n, do: s
  defp truncate(s, n), do: binary_part(s, 0, n - 1) <> "…"
end
