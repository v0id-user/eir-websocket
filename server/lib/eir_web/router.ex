defmodule EirWeb.Router do
  use EirWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {EirWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", EirWeb do
    pipe_through :api

    get "/presets", ApiController, :presets
    get "/groups/:group_id/messages", ApiController, :history
    get "/stats", ApiController, :stats
    get "/sim-url", ApiController, :sim_url
    post "/reset", ApiController, :reset
    post "/chaos", ApiController, :chaos
  end

  scope "/", EirWeb do
    pipe_through :browser
    get "/", PageController, :home
  end

  if Application.compile_env(:eir, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser
      live_dashboard "/dashboard", metrics: EirWeb.Telemetry
    end
  end
end
