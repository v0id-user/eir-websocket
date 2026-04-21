defmodule EirWeb.PageController do
  use EirWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
