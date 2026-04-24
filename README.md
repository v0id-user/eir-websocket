# eir-websocket

A Discord-shaped rig for pushing Elixir/BEAM. You fire simulated clients at a
Phoenix cluster, the cluster fans out broadcasts across all replicas, batches
inserts into Postgres, and streams live metrics to a React dashboard that
shows exactly what the BEAM is doing while it runs.

Playground, not a product. The point is to see the numbers.

## The four things

### server (Elixir, Phoenix 1.8) — the actual demo

Every inbound message hits one hot path:

1. UUIDv7 is minted at ingest. Same id in ETS cache, wire format, and
   Postgres `:uuid` column, so cursor pagination and reply refs stay trivial.
2. The message goes into a per-group `ordered_set` ETS ring buffer, 200
   messages per group. Sub-millisecond recent-history reads.
3. `Phoenix.PubSub` distributed broadcast. With `dns_cluster` auto-meshing
   the 4 Railway replicas over IPv6, a message posted on node A reaches
   every subscribed process on every other node.
4. `Broadway.push_messages/2` hands the message to an async pipeline that
   batches up to 1000 messages or 200ms and does one `Repo.insert_all`.
5. `:telemetry.execute` bumps counters the metrics GenServer samples every
   100ms and broadcasts on a throttled `metrics:live` channel.

Extras in the server:
- `Phoenix.Presence` on every group channel. CRDT-backed roster across the
  cluster.
- `Eir.Bot` subscribes to every group. When a message contains `@bot`, the
  leader-elected bot (lowest node name in the cluster) replies via
  `Chat.ingest/1` with a `reply_to_id` pointing at the triggering message.
  Uses OpenRouter if `OPENROUTER_API_KEY` is set, Anthropic if
  `ANTHROPIC_API_KEY` is set, canned responses otherwise.
- `Eir.Latency` keeps a log-bucketed histogram (64µs to ~8s) for two spans:
  ingest to broadcast and ingest to persisted.
- Cluster-wide reset: one HTTP POST broadcasts `eir:reset` and every node's
  ETS cache, counters, group-counts, and latency histograms clear.
- Channel backpressure: if a slow browser's channel process has more than
  500 queued broadcasts, new broadcasts are dropped rather than accumulated.
  Keeps a stuck client from pinning GB of heap in the cluster.

### simulator — the load generator

Bare `mix new --sup` app. One BEAM process per simulated user. Each holds
a `Mint.WebSocket` connection and speaks the Phoenix Channel v2 protocol
directly (JSON arrays over WS, no Elixir client library).

Triggered with `POST /run`:

```
{ "target": "wss://server/socket/websocket",
  "connections": 500,
  "msgs_per_sec": 10,
  "duration": 30 }
```

Clients now behave like participants: about 33% of messages are replies to
the last message they received, about 15% are @mentions of the author they
last heard from. The simulator isn't a firehose; it reads like a crowded
room.

### client (React + TanStack) — the visualization

Vite + React + TanStack Router + TanStack Query + `phoenix` JS client. Two
views.

Dashboard:
- Two rows of top-level stats: throughput + capacity; then BEAM internals
  (reductions/sec, atoms, ports, ETS tables, memory breakdown, IO, schedulers).
- Throughput chart (60 samples, aggregate across all nodes).
- Nodes panel: one row per replica with its own msgs/sec, connections,
  processes, memory. Dead nodes prune themselves when the cluster shrinks.
- Latency histograms for broadcast and persist spans, merged across nodes,
  with p50/p99/p999/max.
- Scheduler heatmap: 1 row per node × 8 cells per scheduler, HSL-green by
  utilization %.
- Ingest heatmap: node × group table, cell color by relative count. Shows
  how Railway sprinkled WS connections across replicas.
- Simulator panel: control a load run from the browser.
- Chaos panel: kill any replica or a random one.

Chat:
- Channels per group.
- Real Phoenix.Presence list on the right.
- Click a message to reply; the parent renders inline when you send.
- `@name` mentions are highlighted; messages mentioning your current nick
  get an amber accent bar.
- Click a presence entry to insert their `@name` into your draft.
- Nickname is editable; the client sends `set_nick` so presence updates
  across the cluster instead of getting out of sync.

### Postgres

Regular `postgres:16-alpine` image as its own Railway service. Plain
connection string on `postgres.railway.internal`. No volume in the demo
setup (data wipes on Postgres redeploy). Add a volume in the Railway UI
if you want persistence.

## Run locally

### One shot

```
docker compose up --build
```

- server: http://localhost:4000
- simulator: http://localhost:4100
- client: http://localhost:8080
- LiveDashboard (dev only): http://localhost:4000/dev/dashboard

### Hot reload

```
docker run -d --name eir-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=eir_dev -p 5432:5432 postgres:16-alpine
cd server && mix ecto.create && mix ecto.migrate && mix phx.server
cd simulator && mix run --no-halt
cd client && bun dev
```

Open http://localhost:5173.

## Trigger a load run

From the dashboard simulator panel, or:

```
curl -X POST https://eir-simulator-production.up.railway.app/run \
  -H 'content-type: application/json' \
  -d '{"target":"wss://eir-server-production.up.railway.app/socket/websocket",
       "connections":500,"msgs_per_sec":10,"duration":30}'
```

## Chaos: what actually happens when you kill a node

The dashboard chaos button calls `:init.stop/1` on the targeted replica.
Measured behavior in production (4 replicas on Railway Hobby):

- Kill command to cluster-detects-departure: **~2 seconds**
- Detected as down to Railway restart + BEAM boot + dns_cluster rejoin: **~6-7 seconds total**
- Railway assigns the same IPv6 address to the restarted container, so the
  rejoined node name is identical. The "down" window shows on the
  dashboard as `cluster: 3 nodes` for roughly 20 ticks at the 3.3Hz
  broadcast rate.
- After rejoin, the restarted node receives new WS connections
  proportionally (Railway load balancer sprinkles), persists to the same
  shared Postgres, and broadcasts reach it cluster-wide. Its per-node ETS
  cache starts empty and fills as it handles new messages; history reads
  that miss the cache fall through to the shared DB.

So: the heal is real, but the drop is fast. Fire a run first so there's
something to watch.

## Deploy to Railway

One Railway project, four services (server, simulator, client, postgres).
A setup that worked for me:

1. `railway init -n eir-websocket`
2. `railway add --image postgres:16-alpine --service postgres`
3. `railway add --service eir-server` / `eir-simulator` / `eir-client`
4. `railway domain -s eir-server -p 4000`; same for simulator.

Env on `eir-server` (use `railway variable set -s eir-server KEY=value`):
- `PHX_SERVER=true`
- `SECRET_KEY_BASE` (generate with `mix phx.gen.secret`)
- `DATABASE_URL=ecto://postgres:<pw>@postgres.railway.internal:5432/<db>`
- `PHX_HOST=${{RAILWAY_PUBLIC_DOMAIN}}`
- `DNS_CLUSTER_QUERY=eir-server.railway.internal`
- `RELEASE_COOKIE=<hex>`
- `ECTO_IPV6=1`
- Optional: `OPENROUTER_API_KEY=<key>` + `BOT_MODEL=meta-llama/llama-3.1-8b-instruct`

Env on `eir-client` (resolves at build time):
- `VITE_SERVER_URL=https://${{eir-server.RAILWAY_PUBLIC_DOMAIN}}`
- `VITE_SIM_URL=https://${{eir-simulator.RAILWAY_PUBLIC_DOMAIN}}`
- `VITE_SOCKET_URL=wss://${{eir-server.RAILWAY_PUBLIC_DOMAIN}}/socket`

Deploy each from repo root with `--path-as-root`:

```
railway up ./server    -s eir-server    --path-as-root --ci
railway up ./simulator -s eir-simulator --path-as-root --ci
railway up ./client    -s eir-client    --path-as-root --ci
```

Finally `railway domain -s eir-client -p 8080`.

### Scaling the server

Set the replica count on `eir-server` in the Railway UI. `rel/env.sh.eex`
already names each replica `eir@<own-ipv6>` and sets
`ERL_AFLAGS="-proto_dist inet6_tcp"`, so `dns_cluster` meshes them over
IPv6 automatically.

### Sleeping idle services to keep the bill down

This is a demo project, not a production service. Most days nothing is
hitting it. Railway can put services to sleep when they're idle and wake
them on the first incoming request. You want this on for cost reasons.
A few things to know before you flip the toggles.

**Where to flip it.** Per-service setting only available in the Railway
UI, not the CLI:

> service → Settings → Serverless / Sleep when idle → toggle on

There's no `railway` CLI command to set this; you have to click it in
the dashboard. Do it for each service you want to sleep.

**What sleeps cleanly:**

- `eir-client` — static nginx, no background work, sleeps within minutes
  of the last request, wakes on the first new one.
- `eir-simulator` — Elixir app with no scheduled work; sleeps the same
  way. The first POST to `/run` after it slept incurs a ~2-3s cold
  start as the BEAM boots.

**What's tricky:**

- `eir-server` will sleep if you toggle it on, but it has continuous
  internal work that you should be aware of. The metrics GenServer
  ticks every 100ms (now a true no-op when no dashboard subscriber is
  connected — see `lib/eir/metrics.ex`), `dns_cluster` polls DNS every
  ~5s, Phoenix's default telemetry poller fires every 10s. None of
  that generates *external* HTTP traffic, so Railway's sleep heuristic
  (idle = no incoming requests) still triggers, but the BEAM itself is
  doing baseline scheduling work right up until Railway pauses the
  container. If you scale to multiple replicas, internal cluster
  gossip between them counts as activity for the sleep heuristic on
  some services. Test with one replica first.

- `postgres` (the plain `postgres:16-alpine` image used here) is a
  stateful service. Even with sleep enabled, it almost certainly won't
  ever sleep, because:
  1. `eir-server`'s Ecto pool keeps several connections open to it.
  2. Those connections are pinged periodically by `db_connection`.
  3. Postgres sees ongoing activity and Railway's sleep doesn't apply
     to services holding open TCP connections.

  If you really want Postgres to idle, set `POOL_SIZE=1` on `eir-server`
  to minimize the connection count, or switch to Railway's managed
  Postgres addon (it has its own scale-down behavior the plain image
  doesn't). For a demo this isn't worth the complexity — postgres
  staying awake costs cents per day.

**The cascade.** When `eir-server` sleeps, its connection pool drops,
which lets `postgres` go quiet (though still not technically asleep
from Railway's perspective). When all four services are quiet you're
paying ~zero except for the small storage footprint of postgres on
disk. Wake-up on first request is fast for the static services
(<1s) and ~3s for the BEAM cold start.

**The honest tradeoff.** Sleep is great for a demo project. For
anything trying to be a real product, leave the gateway always-on —
~3s cold-start is unacceptable for a "real-time" service, and the
ETS cache empty on every wake means the first wave of history
queries all fall through to Postgres. Sleep is a "this is a portfolio
piece, not infrastructure" choice.

## Data model

One table, `messages`. Primary key is a UUIDv7 canonical string (time
ordered). Index on `(group_id, id DESC)` is all cursor pagination needs:

```
from m in Message,
  where: m.group_id == ^group_id and m.id < ^cursor,
  order_by: [desc: m.id],
  limit: ^page_size
```

## Numbers from a real production run

100 simulated clients × 20 msg/s × 30s on the live deploy:

- msgs/sec in: ~2000
- queue depth: hovers near 0
- ingest to broadcast: p50 128µs, p99 256µs
- ingest to persisted: p50 ≈ 200ms (the Broadway batch timeout)
- reductions/sec per node: hundreds of millions
- memory per replica: ~120–200 MB resident
- processes per replica: 500–1000 (channel processes are cheap)

## What to watch

- Fire a run with 300+ connections and watch the latency histogram fill.
  The broadcast span stays sub-millisecond even at thousands of
  broadcasts/sec.
- Open two tabs: dashboard + `/g/general`. Watch the messages tick up in
  the chat while the counters move on the dashboard.
- Type `@bot hi` in any group. Reply comes from a leader-elected bot
  running on whichever replica has the lowest node name right now.
- Click `[ kill random ]` on the chaos panel. Nodes panel drops to 3,
  holds for ~6 seconds, climbs back to 4.

## Hot code reload

See [docs/hot-reload.md](docs/hot-reload.md) for a walkthrough: `railway
ssh` into a replica, `bin/eir remote` to attach an IEx shell to the
running BEAM, redefine `Eir.Bot.canned/1` mid-flight. No connection drops.

## License

MIT
