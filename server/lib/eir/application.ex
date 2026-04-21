defmodule Eir.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      EirWeb.Telemetry,
      Eir.Repo,
      {DNSCluster, query: Application.get_env(:eir, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Eir.PubSub},
      Eir.Presence,
      Eir.Chat.Cache,
      Eir.Metrics,
      Eir.Chat.Pipeline,
      EirWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: Eir.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    EirWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
