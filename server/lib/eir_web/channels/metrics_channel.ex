defmodule EirWeb.MetricsChannel do
  use Phoenix.Channel

  @impl true
  def join("metrics:live", _params, socket) do
    Phoenix.PubSub.subscribe(Eir.PubSub, "metrics:live")
    send(self(), :push_snapshot)
    {:ok, socket}
  end

  @impl true
  def handle_info(:push_snapshot, socket) do
    push(socket, "snapshot", Eir.Metrics.snapshot())
    {:noreply, socket}
  end

  def handle_info({:metrics_tick, payload}, socket) do
    push(socket, "tick", payload)
    {:noreply, socket}
  end
end
