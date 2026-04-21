defmodule Eir.Chat.Pipeline do
  @moduledoc """
  Broadway pipeline that batches message inserts to Postgres.

  Each node runs its own pipeline. Hot path calls `push/1` which uses
  `Broadway.push_messages/2` to enqueue into a DummyProducer; the pipeline
  batches up to `@batch_size` messages or `@batch_timeout_ms`, whichever
  comes first, then does one `Repo.insert_all/3`.
  """

  use Broadway
  alias Broadway.Message

  @batch_size 1_000
  @batch_timeout_ms 200
  @depth_table :eir_pipeline_depth

  def start_link(_opts) do
    case :ets.whereis(@depth_table) do
      :undefined ->
        :ets.new(@depth_table, [:set, :public, :named_table, write_concurrency: true])

      _ ->
        :ok
    end

    :ets.insert(@depth_table, {:q, 0})

    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {Broadway.DummyProducer, []},
        concurrency: 1
      ],
      processors: [
        default: [concurrency: System.schedulers_online()]
      ],
      batchers: [
        db: [concurrency: 2, batch_size: @batch_size, batch_timeout: @batch_timeout_ms]
      ]
    )
  end

  @doc "Push a message onto the pipeline. Non-blocking."
  def push(%Eir.Chat.Message{} = m) do
    :ets.update_counter(@depth_table, :q, {2, 1}, {:q, 0})

    Broadway.push_messages(__MODULE__, [
      %Message{data: m, acknowledger: Broadway.NoopAcknowledger.init()}
    ])
  end

  @doc "Current buffered count (messages waiting to be batched & persisted)."
  def queue_depth do
    case :ets.whereis(@depth_table) do
      :undefined ->
        0

      _ ->
        :ets.update_counter(@depth_table, :q, {2, 0}, {:q, 0})
    end
  end

  @impl Broadway
  def handle_message(_, %Message{} = message, _ctx) do
    Message.put_batcher(message, :db)
  end

  @impl Broadway
  def handle_batch(:db, messages, _batch_info, _ctx) do
    rows = Enum.map(messages, fn %Message{data: m} -> Eir.Chat.Message.to_row(m) end)

    {count, _} =
      Eir.Repo.insert_all(
        Eir.Chat.Message,
        rows,
        on_conflict: :nothing,
        placeholders: %{},
        returning: false
      )

    :ets.update_counter(@depth_table, :q, {2, -count}, {:q, 0})
    :telemetry.execute([:eir, :pipeline, :batch_persisted], %{count: count}, %{})
    messages
  end
end
