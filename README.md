# eir-websocket

A Discord-shaped rig for pushing Elixir/BEAM to the edge and watching it grin.
You fire simulated clients at a Phoenix server, the server fans out broadcasts
across a cluster, batches inserts to Postgres, and streams live metrics to a
React dashboard so you can watch the numbers move in real time.

This is a playground, not a product. The goal is to see what BEAM actually does
when you throw a few thousand WebSocket connections at it.

## The three services

### server (Elixir, Phoenix 1.8)

The star of the show. Every inbound message hits the same hot path:

1. A UUIDv7 id is minted at ingest so the same id lives in cache, DB, and on
   the wire. Cursor pagination and reply refs are trivial because of this.
2. The message goes into a per-group `ordered_set` ETS ring buffer (500 msgs
   per group) for sub-millisecond recent-history reads.
3. A `Phoenix.PubSub` broadcast fans it out to every subscribed process across
   the cluster. With `dns_cluster` wiring nodes up automatically, a message
   posted on node A reaches subscribers on node B transparently.
4. `Broadway.push_messages/2` hands it to an async pipeline that batches up to
   1000 messages or 200ms (whichever comes first) into one `Repo.insert_all`.
5. `:telemetry.execute` bumps a counter that the metrics GenServer samples
   every 100ms and broadcasts on a `metrics:live` channel.

History reads are cache-first: a partial cache hit tops up from Postgres, a
miss falls through. Same ULID cursor on both sides so the two layers stay
in sync without any extra bookkeeping.

`Phoenix.LiveDashboard` is mounted at `/dev/dashboard` in dev for BEAM-native
observability (process tree, ETS, mailboxes, scheduler utilization).

### simulator (Elixir)

Bare `mix new --sup` app. One BEAM process per simulated user, each holding
a `Mint.WebSocket` connection to the server and speaking Phoenix Channel v2
protocol directly (JSON arrays over WS).

Triggered via HTTP:

```
POST /run
{ "target": "ws://server/socket/websocket",
  "connections": 500,
  "msgs_per_sec": 10,
  "duration": 30 }
```

Each client is a supervised GenServer. Ramp-up is staggered to avoid a
thundering herd on the target. Counters (sent, received, errors) live in
ETS and get exposed at `GET /stats`.

### client (React + TanStack)

Vite + React + TanStack Router + TanStack Query + `phoenix` JS client. Two
views:

- `/` the dashboard. Subscribes to `metrics:live` and renders msgs/sec in,
  msgs/sec persisted, queue depth, WS connections, process count, memory,
  run queue, per-group cache depth, and a control panel that fires the
  simulator.
- `/g/:groupId` the chat view. Joins a group channel, loads history via
  the group channel's ok-payload, appends live broadcasts as they arrive.

## Running locally

### Fast path: docker-compose

```
docker compose up --build
```

That brings up Postgres, the server, the simulator, and the client.

- server: http://localhost:4000 (LiveDashboard at http://localhost:4000/dev/dashboard)
- simulator: http://localhost:4100
- client: http://localhost:8080

### Hot reload

```
docker run -d --name eir-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=eir_dev -p 5432:5432 postgres:16-alpine

cd server && mix ecto.create && mix ecto.migrate && mix phx.server
cd simulator && mix run --no-halt
cd client && bun dev
```

Open http://localhost:5173.

## Triggering a load run

From the dashboard panel: set connections, msgs/sec, duration, click run.

From the CLI:

```
curl -X POST http://localhost:4100/run \
  -H 'content-type: application/json' \
  -d '{"target":"ws://localhost:4000/socket/websocket","connections":500,"msgs_per_sec":10,"duration":30}'
```

Watch the dashboard. The fun one is opening two tabs: dashboard in one,
`/g/general` in the other. You can see the same messages land in the chat
stream while the counters tick up.

## Deploying to Railway

One Railway project, four things: a Postgres addon plus three services
(`eir-server`, `eir-simulator`, `eir-client`).

```
railway init -n eir-websocket
railway add -d postgres

railway add --service eir-server
railway add --service eir-simulator
railway add --service eir-client

railway domain -s eir-server    -p 4000
railway domain -s eir-simulator -p 4100
```

Set server env:

```
railway variable -s eir-server set PHX_SERVER=true
railway variable -s eir-server set "SECRET_KEY_BASE=$(openssl rand -base64 48)"
railway variable -s eir-server set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway variable -s eir-server set 'PHX_HOST=${{RAILWAY_PUBLIC_DOMAIN}}'
railway variable -s eir-server set DNS_CLUSTER_QUERY=eir-server.railway.internal
railway variable -s eir-server set RELEASE_COOKIE="$(openssl rand -hex 16)"
```

Client env (references resolve at build time, so order does not matter):

```
railway variable -s eir-client set 'VITE_SERVER_URL=https://${{eir-server.RAILWAY_PUBLIC_DOMAIN}}'
railway variable -s eir-client set 'VITE_SIM_URL=https://${{eir-simulator.RAILWAY_PUBLIC_DOMAIN}}'
railway variable -s eir-client set 'VITE_SOCKET_URL=wss://${{eir-server.RAILWAY_PUBLIC_DOMAIN}}/socket'
```

Deploy each service from its subdir:

```
cd server    && railway up -s eir-server    --ci
cd simulator && railway up -s eir-simulator --ci
cd client    && railway up -s eir-client    --ci
```

Finally:

```
railway domain -s eir-client -p 8080
```

### Clustering

Scale the server to two or more replicas from the Railway dashboard. The
`dns_cluster` lib polls the internal DNS name (`eir-server.railway.internal`)
and auto-connects BEAM nodes. `Phoenix.PubSub.PG2` handles cross-node
broadcasts for free. The dashboard's cluster panel lists every connected node.

## Data model

One table, `messages`. Primary key is a UUIDv7 string (time-ordered). An
index on `(group_id, id DESC)` is all you need for cursor pagination:

```
from m in Message,
  where: m.group_id == ^group_id and m.id < ^cursor,
  order_by: [desc: m.id],
  limit: ^page_size
```

No offsets, no keyset hacks.

## What to watch while it runs

Fire a big run (a few thousand connections, 10 msg/s each) and look at:

- `msgs/sec in` vs `msgs/sec persisted`: Broadway absorbing spikes, queue
  depth hovering near zero.
- `processes`: will sit at `connections + a few hundred` overhead. BEAM does
  not flinch at tens of thousands of processes.
- `memory`: per-process cost stays tiny, typically under 10 KB each.
- `cache by group`: fan-out visible live. Click through to a group's chat
  view to read the same stream the numbers are describing.
- `cluster`: scale up replicas on Railway and watch nodes appear in the list.

## License

MIT
