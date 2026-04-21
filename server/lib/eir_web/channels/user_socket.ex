defmodule EirWeb.UserSocket do
  use Phoenix.Socket

  channel "group:*", EirWeb.GroupChannel
  channel "metrics:*", EirWeb.MetricsChannel

  @impl true
  def connect(params, socket, _connect_info) do
    nickname =
      params["nickname"]
      |> to_string()
      |> String.trim()
      |> case do
        "" -> "anon-" <> Integer.to_string(:erlang.unique_integer([:positive]), 36)
        n -> n
      end

    {:ok, assign(socket, :nickname, nickname)}
  end

  @impl true
  def id(_socket), do: nil
end
