defmodule Eir.Repo.Migrations.CreateMessages do
  use Ecto.Migration

  def change do
    create table(:messages, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :group_id, :text, null: false
      add :author, :text, null: false
      add :body, :text, null: false
      add :reply_to_id, :uuid
      add :node, :text
      add :inserted_at, :utc_datetime_usec, null: false
    end

    create index(:messages, [:group_id, :id])
  end
end
