defmodule Eir.Repo do
  use Ecto.Repo,
    otp_app: :eir,
    adapter: Ecto.Adapters.Postgres
end
