defmodule Eir.Presence do
  @moduledoc """
  Phoenix.Presence tracker. Distributed across the cluster via a CRDT, so
  who's in each group stays consistent across all 4 replicas without any
  explicit coordination from us. Join/leave on any node is visible to
  subscribers on every other node.
  """

  use Phoenix.Presence,
    otp_app: :eir,
    pubsub_server: Eir.PubSub
end
