defmodule Eir.Chat.Message do
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: false}
  @foreign_key_type :binary_id

  schema "messages" do
    field :group_id, :string
    field :author, :string
    field :body, :string
    field :reply_to_id, :binary_id
    field :node, :string
    field :inserted_at, :utc_datetime_usec
  end

  @doc "Build a new in-memory message (pre-persist) with a fresh UUIDv7."
  def new(attrs) do
    %__MODULE__{
      id: Eir.ID.generate_bin(),
      group_id: Map.fetch!(attrs, :group_id),
      author: Map.fetch!(attrs, :author),
      body: Map.fetch!(attrs, :body),
      reply_to_id: normalize_reply(attrs[:reply_to_id]),
      node: to_string(node()),
      inserted_at: DateTime.utc_now()
    }
  end

  @doc "Shape for Phoenix.PubSub broadcasts and JSON responses."
  def to_wire(%__MODULE__{} = m) do
    %{
      id: id_to_string(m.id),
      group_id: m.group_id,
      author: m.author,
      body: m.body,
      reply_to_id: m.reply_to_id && id_to_string(m.reply_to_id),
      node: m.node,
      inserted_at: DateTime.to_iso8601(m.inserted_at)
    }
  end

  defp id_to_string(<<_::binary-size(16)>> = b), do: Eir.ID.bin_to_string(b)
  defp id_to_string(<<_::binary-size(36)>> = s), do: s

  @doc "Row shape for Repo.insert_all/3 — no Ecto cast overhead."
  def to_row(%__MODULE__{} = m) do
    %{
      id: Eir.ID.bin_to_string(m.id),
      group_id: m.group_id,
      author: m.author,
      body: m.body,
      reply_to_id: m.reply_to_id && Eir.ID.bin_to_string(m.reply_to_id),
      node: m.node,
      inserted_at: m.inserted_at
    }
  end

  defp normalize_reply(nil), do: nil
  defp normalize_reply(<<_::binary-size(16)>> = bin), do: bin
  defp normalize_reply(<<_::binary-size(36)>> = s), do: Eir.ID.string_to_bin(s)
end
