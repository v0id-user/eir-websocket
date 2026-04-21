defmodule EirWeb.UserSocket do
  use Phoenix.Socket

  channel "group:*", EirWeb.GroupChannel
  channel "metrics:*", EirWeb.MetricsChannel

  @max_nickname_bytes 64

  @impl true
  def connect(params, socket, _connect_info) do
    nickname =
      params["nickname"]
      |> to_string()
      |> String.trim()
      |> sanitize_nick()

    {:ok, assign(socket, :nickname, nickname)}
  end

  defp sanitize_nick(""), do: "anon-" <> Integer.to_string(:erlang.unique_integer([:positive]), 36)

  defp sanitize_nick(n) when byte_size(n) > @max_nickname_bytes,
    do: binary_part(n, 0, @max_nickname_bytes)

  defp sanitize_nick(n), do: n

  @impl true
  def id(_socket), do: nil
end
