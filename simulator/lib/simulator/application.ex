defmodule Simulator.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT") || "4100")

    children = [
      Simulator.Stats,
      {Registry, keys: :duplicate, name: Simulator.ClientRegistry},
      {DynamicSupervisor, name: Simulator.ClientSup, strategy: :one_for_one},
      {Simulator.RunManager, []},
      {Bandit, plug: Simulator.Router, port: port}
    ]

    opts = [strategy: :one_for_one, name: Simulator.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
