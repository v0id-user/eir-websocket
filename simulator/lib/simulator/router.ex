defmodule Simulator.Router do
  use Plug.Router

  plug CORSPlug, origin: ["*"]
  plug :match
  plug Plug.Parsers, parsers: [:json], pass: ["application/json"], json_decoder: Jason
  plug :dispatch

  get "/health" do
    send_json(conn, %{ok: true, node: to_string(node())})
  end

  get "/stats" do
    send_json(conn, Simulator.Stats.snapshot())
  end

  get "/run" do
    send_json(conn, %{run: Simulator.RunManager.current_run()})
  end

  post "/run" do
    handle_run(conn)
  end

  post "/stop" do
    Simulator.RunManager.stop_run()
    send_json(conn, %{ok: true})
  end

  post "/reset" do
    Simulator.RunManager.stop_run()
    Simulator.Stats.reset()
    send_json(conn, %{ok: true})
  end

  match _ do
    send_json(conn, %{error: "not_found"}, 404)
  end

  defp handle_run(conn) do
    try do
      case Simulator.RunManager.start_run(conn.body_params) do
        {:ok, info} -> send_json(conn, %{ok: true, run: info})
        {:error, :already_running} -> send_json(conn, %{ok: false, error: "already_running"}, 409)
      end
    rescue
      e -> send_json(conn, %{ok: false, error: Exception.message(e)}, 400)
    end
  end

  defp send_json(conn, body, status \\ 200) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(body))
  end
end
