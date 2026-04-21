defmodule EirWeb.ApiController do
  use EirWeb, :controller

  alias Eir.Chat

  def presets(conn, _params) do
    json(conn, Chat.presets())
  end

  def history(conn, %{"group_id" => group_id} = params) do
    before = params["before"]
    limit = params["limit"] |> parse_int(50) |> min(200)

    {source, messages} = Chat.history(group_id, before, limit)

    json(conn, %{source: source, messages: messages})
  end

  def reset(conn, _params) do
    Chat.reset_all()
    json(conn, %{ok: true})
  end

  def stats(conn, _params) do
    json(conn, Eir.Metrics.snapshot())
  end

  def sim_url(conn, _params) do
    url = Application.get_env(:eir, :simulator_url, "")
    json(conn, %{url: url})
  end

  defp parse_int(nil, default), do: default
  defp parse_int(n, _) when is_integer(n), do: n

  defp parse_int(s, default) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> default
    end
  end
end
