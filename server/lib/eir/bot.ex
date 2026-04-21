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
  @openrouter_default_model "meta-llama/llama-3.3-70b-instruct:free"
  @max_reply_chars 400

  # Each node starts its own bot. Only the node that is the current "leader"
  # (lowest node name in the sorted cluster) actually replies, so we don't
  # duplicate responses across the cluster. Leader election is recomputed
  # on every message — zero coordination cost.
  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    for g <- Eir.Chat.presets().groups do
      Phoenix.PubSub.subscribe(Eir.PubSub, "group:" <> g)
    end

    provider =
      cond do
        System.get_env("OPENROUTER_API_KEY") not in [nil, ""] ->
          {:openrouter, System.get_env("OPENROUTER_API_KEY"),
           System.get_env("BOT_MODEL") || @openrouter_default_model}

        System.get_env("ANTHROPIC_API_KEY") not in [nil, ""] ->
          {:anthropic, System.get_env("ANTHROPIC_API_KEY"), @anthropic_model}

        true ->
          :canned
      end

    state = %{provider: provider, busy?: false}
    Logger.info("Eir.Bot provider: #{inspect(elem_or_self(provider))}")
    {:ok, state}
  end

  defp elem_or_self({tag, _key, model}), do: "#{tag} (#{model})"
  defp elem_or_self(other), do: other

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
    provider = state.provider
    group_id = msg.group_id
    msg_id = msg.id
    prompt = msg.body

    # Run under a supervised Task with monitor so if Eir.Bot crashes, the
    # in-flight LLM call is also torn down (no orphaned HTTP request
    # inventing a bot reply after the bot itself is dead).
    Task.Supervisor.start_child(Eir.Bot.TaskSup, fn ->
      reply =
        case provider do
          {:openrouter, key, model} -> ask_openrouter(prompt, key, model) || canned(prompt)
          {:anthropic, key, _model} -> ask_claude(prompt, key) || canned(prompt)
          :canned -> canned(prompt)
        end

      if is_binary(reply) and reply != "" and Process.alive?(parent) do
        Eir.Chat.ingest(%{
          group_id: group_id,
          author: @bot_nick,
          body: truncate(reply, @max_reply_chars),
          reply_to_id: msg_id
        })
      end

      if Process.alive?(parent), do: send(parent, {:reply_done, msg_id})
    end)
  end

  defp ask_openrouter(prompt, api_key, model) do
    body =
      Jason.encode!(%{
        model: model,
        max_tokens: 220,
        messages: [
          %{
            role: "system",
            content:
              "You are a terse chat bot in a stress-test chatroom on an Elixir/BEAM server. " <>
                "Keep replies under 2 short sentences. Lowercase, no emojis, irc-ish tone. " <>
                "If asked about infra, know the stack is Phoenix + Broadway + ETS + Phoenix.PubSub " <>
                "across 4 clustered nodes on Railway."
          },
          %{role: "user", content: prompt}
        ]
      })

    headers = [
      {~c"authorization", String.to_charlist("Bearer " <> api_key)},
      {~c"content-type", ~c"application/json"},
      {~c"http-referer", ~c"https://eir-client-production.up.railway.app"},
      {~c"x-title", ~c"eir-websocket"}
    ]

    request =
      {~c"https://openrouter.ai/api/v1/chat/completions", headers, ~c"application/json", body}

    case :httpc.request(:post, request, [{:timeout, 20_000}], []) do
      {:ok, {{_, 200, _}, _hdrs, resp_body}} ->
        case Jason.decode(IO.iodata_to_binary(resp_body)) do
          {:ok, %{"choices" => [%{"message" => %{"content" => text}} | _]}} when is_binary(text) ->
            String.trim(text)

          other ->
            Logger.warning("bot openrouter parse error: #{inspect(other)}")
            nil
        end

      {:ok, {{_, status, _}, _hdrs, resp_body}} ->
        Logger.warning(
          "bot openrouter http #{status}: #{IO.iodata_to_binary(resp_body) |> String.slice(0, 300)}"
        )

        nil

      other ->
        Logger.warning("bot openrouter transport error: #{inspect(other)}")
        nil
    end
  rescue
    e ->
      Logger.warning("bot openrouter crash: #{Exception.message(e)}")
      nil
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
