// Documentation page. Scrollable long-form with inline SVG diagrams.
// All silver-on-black to match the rest. No deps.

export function What() {
  return (
    <div
      style={{
        padding: "20px 24px 80px",
        maxWidth: 920,
        margin: "0 auto",
        fontSize: 13,
        lineHeight: 1.55,
        color: "#c0c0c0",
      }}
    >
      <H1>what is this</H1>

      <P>
        A stress-testing rig for an Elixir/Phoenix chat backend, deployed on
        Railway. You fire simulated clients at the cluster, the cluster fans
        out broadcasts across replicas, batches inserts to Postgres, and a
        React dashboard streams live metrics so you can watch BEAM do the
        work in real time. Not a product. The point is to see the numbers
        move.
      </P>

      <H2>why does this exist</H2>
      <P>
        BEAM (the Erlang/Elixir VM) has a set of properties that are weirdly
        rare in mainstream stacks: lightweight processes, preemptive
        scheduling, in-process distributed messaging, built-in ETS for
        in-memory KV, and hot code reload in production. Most descriptions
        of these are abstract. This project tries to make them visible.
        Click the simulator's <Code>stress</Code> preset, watch the numbers,
        and the abstract becomes a thing on a screen.
      </P>

      <H2>how does elixir pull this off</H2>
      <P>
        The whole rig — thousands of WebSockets, a fan-out broadcast layer,
        a distributed cluster, an async batched persistence pipeline — runs
        on one runtime in one language with no Redis, no Kafka, no nginx
        sticky sessions. That's not a marketing line; it's a consequence of
        how BEAM is built. Six concrete properties do the work.
      </P>

      <SVGWrapper>
        <ProcessVsThreadDiagram />
      </SVGWrapper>

      <Numbered>
        <NumberedItem n="1" t="processes are not threads">
          A BEAM process is not an OS thread. Initial heap is a few hundred
          words (~2 KB), the scheduler can hold millions in a single VM,
          and creating one is a function call (microseconds). Every
          WebSocket in this app is its own process; one connection's
          mailbox can't block another's. There is no shared mutable state
          inside a process to lock around. When something fails, you crash
          one process, not the runtime.
        </NumberedItem>

        <NumberedItem n="2" t="preemptive scheduling, per-process heap">
          The scheduler interrupts a running process every ~2000{" "}
          <I>reductions</I> (≈ function calls) and picks another one,
          regardless of what the first was doing. That's why a CPU-bound
          process can't starve a WebSocket reader, and why the BEAM never
          has the "one slow request blocks the event loop" failure mode of
          single-threaded async runtimes (Node, asyncio). Each process
          also has its own heap; garbage collection is per-process and
          stop-the-world for that process only — never for the whole VM.
          So a busy chat replica doesn't pause itself to GC the chat
          history of an unrelated user.
        </NumberedItem>

        <NumberedItem n="3" t="message-passing instead of shared memory">
          Processes communicate by copying terms into each other's
          mailboxes. The receiving process pulls one off, pattern-matches,
          handles it, repeats. There are no locks because there is no
          shared mutable state to lock. <Code>send</Code> is async (fire
          and forget) and never blocks the sender. This is what makes
          Phoenix.Channel cheap: a broadcast is N async sends, the
          channel processes drain their own mailboxes at their own pace,
          and slow consumers can't deadlock fast ones.
        </NumberedItem>

        <NumberedItem n="4" t="distribution is in the runtime">
          Connecting two BEAM nodes is one function call:{" "}
          <Code>:net_kernel.connect_node/1</Code>. Once connected,
          you can <Code>send</Code> a message to a process on another node
          using the same syntax as a local send. Names register globally
          via <Code>:global</Code> or process groups via <Code>:pg</Code>.
          Phoenix.PubSub uses <Code>:pg</Code> so a broadcast on node A
          reaches subscribers on every other node with no extra
          infrastructure — no Redis pub/sub, no NATS, no Kafka topic. The
          cluster discovery (<Code>dns_cluster</Code>) is a 200-line
          library; the actual mesh is BEAM.
        </NumberedItem>

        <NumberedItem n="5" t="ETS: in-memory KV inside the VM">
          The recent-history cache, the metric counters, the latency
          histograms, the per-group ring buffers — all of them are{" "}
          <Code>:ets</Code> tables. Lock-free concurrent reads,
          configurable concurrency for writes, lookup in O(log N) for
          ordered_set, and the table sits in the same process space as the
          server itself. No serialization, no IPC, no separate Redis box.
          You'd reach for Redis when your Node app needed to share state
          across workers; in BEAM the workers already share the same VM,
          and ETS is the way they share without locks.
        </NumberedItem>

        <NumberedItem n="6" t="OTP: supervision is the deployment model">
          Every long-lived process in this server (the Cache, Metrics,
          Bot, Broadway pipeline, channels) is owned by a supervisor that
          restarts it on crash. Failure is handled the same way regardless
          of whether the failing process is a single channel or the entire
          DB pipeline. The chaos button on the dashboard exploits this:
          killing <Code>:init.stop/1</Code> wipes the BEAM, Railway
          restarts the container, the supervisor starts everything in
          order, dns_cluster reconnects, broadcasts resume. There is no
          imperative "wire it back up" step anywhere.
        </NumberedItem>
      </Numbered>

      <P>
        Put together: a Node server doing this would need nginx for sticky
        sessions, Redis for cross-process pub/sub, a worker queue for the
        async DB writes, and careful design to keep one slow handler from
        starving the event loop. A Go server could match the throughput
        but would lose hot reload, distribution-by-default, and
        per-process heaps. BEAM's pitch isn't speed; it's that all four
        of (concurrency, distribution, isolation, fault tolerance) are
        already in the runtime so you can compose them without
        infrastructure.
      </P>

      <H2>architecture</H2>
      <SVGWrapper>
        <ArchitectureDiagram />
      </SVGWrapper>
      <P>
        Four services in one Railway project. The <B>client</B> is a static
        React bundle served by nginx. It opens one WebSocket to{" "}
        <B>eir-server</B> for chat + metrics, and HTTP-POSTs to{" "}
        <B>eir-simulator</B> to start a load run. The simulator opens
        thousands of its own WebSockets back at <B>eir-server</B> to behave
        like real users. <B>postgres</B> is the cold-tier persistence on a
        private network, only the server talks to it.
      </P>

      <H2>the hot path · what happens when one message lands</H2>
      <SVGWrapper>
        <HotPathDiagram />
      </SVGWrapper>
      <P>
        Five things in order, each cheap. The slow one (Postgres insert) is
        deferred behind a Broadway batch so the WebSocket round-trip stays
        sub-millisecond. The id is a UUIDv7 minted at step{" "}
        <Code>0</Code>, so the same identifier lives in the ETS ring, the
        broadcast payload, and the Postgres row — no separate id assignment
        anywhere downstream.
      </P>

      <Numbered>
        <NumberedItem n="0" t="UUIDv7 mint">
          128-bit time-ordered id. Sortable lexicographically by creation
          time, so cursor pagination is just <Code>where id &lt; ?</Code>.
        </NumberedItem>
        <NumberedItem n="1" t="ETS cache put">
          ~5 µs. <Code>ordered_set</Code> table keyed by{" "}
          <Code>{`{group_id, id}`}</Code>. A ring buffer per group, capped at
          200, trimmed lazily.
        </NumberedItem>
        <NumberedItem n="2" t="Phoenix.PubSub broadcast">
          ~100 µs. Distributed via <Code>:pg</Code>. Reaches every subscribed
          channel process on every replica. The originator's channel is
          included.
        </NumberedItem>
        <NumberedItem n="3" t="cluster cache:sync">
          Same broadcast wave mirrors the message into every other replica's
          local ETS so a reader landing on any node sees the message
          immediately, even before the DB write completes.
        </NumberedItem>
        <NumberedItem n="4" t="Broadway push">
          ~1 µs. Drops the message into a 1000-msg batch. The pipeline
          flushes when the batch fills or after 200 ms, whichever comes
          first.
        </NumberedItem>
        <NumberedItem n="5" t="Repo.insert_all">
          One SQL roundtrip for the whole batch. p50 about 50 ms under
          normal load. So a single message sees ~200 ms end-to-end to be
          durable, and ~100 µs to be visible to every reader.
        </NumberedItem>
      </Numbered>

      <H2>cluster topology</H2>
      <SVGWrapper>
        <ClusterDiagram />
      </SVGWrapper>
      <P>
        Each replica boots with a node name like{" "}
        <Code>eir@&lt;its-own-IPv6&gt;</Code>. <Code>dns_cluster</Code>{" "}
        polls the service's internal DNS every few seconds, gets every
        replica's IP, and connects them with{" "}
        <Code>:net_kernel.connect_node/1</Code>. Once connected,{" "}
        <Code>Phoenix.PubSub.PG2</Code> auto-distributes broadcasts across
        the mesh and <Code>Phoenix.Presence</Code> uses a CRDT to keep its
        roster consistent without any explicit coordination from us.
      </P>
      <P>
        Each replica has its own Broadway pipeline draining to the same
        shared Postgres. Each replica has its own ETS cache; a tiny
        cache-sync broadcast keeps them in lock-step for recent messages
        without making the cache itself a distributed data structure.
      </P>

      <H2>two things to watch on the dashboard</H2>

      <H3>broadcast vs persist latency</H3>
      <P>
        The two latency histograms are different stories. <B>broadcast</B>{" "}
        is the cost of fan-out across the cluster — sub-millisecond on a
        warm BEAM, regardless of subscriber count. <B>persist</B> is gated
        by Broadway's batch timeout (200 ms) so you'll see a hard wall
        around p50 ≈ 200 ms at low load (the timeout fires before the batch
        fills). Under heavier sustained load, batches fill before the
        timeout and persist latency drops sharply because more rows ride in
        each insert.
      </P>

      <H3>fan-out</H3>
      <P>
        On the simulator panel, <B>recv/s ÷ sent/s</B> is how many
        subscribers each chat message reaches. With 150 clients spread
        across 8 groups that's ~19. With 1500 clients in the same 8 groups
        it'd be ~187. The dashboard's "msgs/sec in" measures unique
        ingests; the "deliveries" the server actually performs is{" "}
        <I>ingests × fan-out</I>. That's what people mean when they say
        chat is a hard write workload — the broadcast multiplier is real
        and lives in your I/O budget.
      </P>

      <H2>why these specific tools</H2>
      <Two>
        <Card t="Phoenix.Channel">
          One BEAM process per WebSocket. Cheap (a few KB of heap).
          Receiving a broadcast is one mailbox message; pushing to the
          socket is one write. Backpressure is mailbox depth.
        </Card>
        <Card t="Phoenix.PubSub">
          Distributed pub/sub built on Erlang's <Code>:pg</Code> process
          groups. Subscribing is one call; broadcasting reaches every
          subscriber on every connected node with no extra infrastructure.
        </Card>
        <Card t="Phoenix.Presence">
          CRDT-backed roster. <Code>track/3</Code> on any node is visible
          on every node within ~ms. No explicit sync, no Redis.
        </Card>
        <Card t="Broadway">
          GenStage-based async pipeline with batching, backpressure, and
          rate limiting baked in. The persist tier is two lines of config
          (batch_size, batch_timeout).
        </Card>
        <Card t="ETS">
          In-process KV store with optional ordering and concurrency
          tuning. The cache, the metrics counters, the latency histograms,
          the per-group ring buffers — all ETS. No Redis.
        </Card>
        <Card t="dns_cluster">
          Tiny library, one config option (a DNS name). Every node polls
          and connects to whatever IPs come back. The whole clustering
          setup is a single env var on Railway.
        </Card>
      </Two>

      <H2>data model</H2>
      <P>
        One Postgres table, <Code>messages</Code>:
      </P>
      <Pre>{`id           uuid (UUIDv7, time-ordered) PK
group_id     text
author       text
body         text
reply_to_id  uuid  (nullable, for threading)
node         text  (which replica ingested)
inserted_at  timestamptz`}</Pre>
      <P>
        Index on <Code>(group_id, id DESC)</Code>. That's all cursor
        pagination needs:
      </P>
      <Pre>{`from m in Message,
  where: m.group_id == ^group_id and m.id < ^cursor,
  order_by: [desc: m.id],
  limit: ^page_size`}</Pre>
      <P>
        Because UUIDv7 sorts by creation time, lexicographic order = time
        order. No offsets, no compound keysets, no separate sequence
        column. The same id from <Code>Eir.ID.generate()</Code> at ingest
        is the cache key, the wire payload's <Code>id</Code> field, and
        the Postgres primary key.
      </P>

      <H2>what to try</H2>
      <Numbered>
        <NumberedItem n="1" t="open the dashboard, fire normal">
          150 connections × 8 msg/s × 30 s. Watch ingest fill the chart,
          fan-out land in recv/s. The latency histograms populate within a
          second.
        </NumberedItem>
        <NumberedItem n="2" t="open chat in another tab">
          The simulator clients now reply to each other (~33% of messages
          are replies; ~15% include @mentions). The chat reads like a real
          room.
        </NumberedItem>
        <NumberedItem n="3" t="say @bot anything in any group">
          Leader-elected bot replies via OpenRouter's Llama 3.1 8B (or
          canned responses if no key is set). The reply lands as a
          threaded message via the same hot path everything else uses.
        </NumberedItem>
        <NumberedItem n="4" t="bump to spicy or stress">
          Watch the persist-latency p50 drop as batches fill before the
          200 ms timeout. The broadcast histogram stays sub-millisecond.
        </NumberedItem>
        <NumberedItem n="5" t="scale eir-server to 2+ replicas in the railway ui">
          The cluster panel shows the new node within a few seconds. Then
          the chaos panel becomes interesting — kill one, watch the
          cluster go to N-1 for ~6 s and recover.
        </NumberedItem>
      </Numbered>

      <H2>source</H2>
      <P>
        <a
          href="https://github.com/v0id-user/eir-websocket"
          style={{ color: "#c9a76a", textDecoration: "underline" }}
        >
          github.com/v0id-user/eir-websocket
        </a>
        . MIT.
      </P>
    </div>
  );
}

// --- diagrams ---

function ProcessVsThreadDiagram() {
  // Two columns: OS thread "1 connection = 1 thread" vs BEAM process.
  // Visualize the size delta and per-process heap.
  return (
    <svg viewBox="0 0 760 230" width="100%" style={{ display: "block" }}>
      <defs>
        <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="0.8" fill="#444" />
        </pattern>
      </defs>

      {/* left: OS thread */}
      <text x={20} y={22} fill="#888" fontSize={11} fontFamily="monospace">
        traditional OS thread per connection
      </text>
      <rect x={20} y={36} width={340} height={170} fill="url(#dots)" stroke="#333" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <g key={i}>
          <rect
            x={36 + (i % 3) * 108}
            y={56 + Math.floor(i / 3) * 70}
            width={92}
            height={54}
            fill="#0a0a0a"
            stroke="#5a4040"
          />
          <text x={36 + (i % 3) * 108 + 46} y={75 + Math.floor(i / 3) * 70} fill="#c0c0c0" fontSize={10} textAnchor="middle" fontFamily="monospace">
            thread #{i + 1}
          </text>
          <text x={36 + (i % 3) * 108 + 46} y={89 + Math.floor(i / 3) * 70} fill="#888" fontSize={9} textAnchor="middle" fontFamily="monospace">
            ~8 MB stack
          </text>
          <text x={36 + (i % 3) * 108 + 46} y={101 + Math.floor(i / 3) * 70} fill="#666" fontSize={9} textAnchor="middle" fontFamily="monospace">
            shared heap
          </text>
        </g>
      ))}
      <text x={190} y={224} fill="#666" fontSize={10} textAnchor="middle" fontFamily="monospace">
        ~thousands max · GC pauses everyone · locks for shared state
      </text>

      {/* right: BEAM */}
      <text x={400} y={22} fill="#888" fontSize={11} fontFamily="monospace">
        BEAM process per connection
      </text>
      <rect x={400} y={36} width={340} height={170} fill="url(#dots)" stroke="#3a4a3a" />
      {Array.from({ length: 96 }).map((_, i) => {
        const cols = 12;
        const cw = 22;
        const ch = 14;
        const x = 412 + (i % cols) * (cw + 4);
        const y = 50 + Math.floor(i / cols) * (ch + 4);
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={cw}
            height={ch}
            fill="#0a0a0a"
            stroke="#3a4a3a"
            strokeWidth={0.5}
          />
        );
      })}
      <text x={570} y={224} fill="#666" fontSize={10} textAnchor="middle" fontFamily="monospace">
        millions per VM · per-process heap · no shared state · no locks
      </text>
    </svg>
  );
}

function ArchitectureDiagram() {
  return (
    <svg viewBox="0 0 760 280" width="100%" style={{ display: "block" }}>
      <defs>
        <marker
          id="arr"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#888" />
        </marker>
      </defs>

      <Box x={20} y={100} w={140} h={80} title="client" sub="React + TanStack" sub2="static, nginx" />
      <Box x={300} y={40} w={160} h={80} title="eir-server" sub="Phoenix" sub2="× N replicas" accent />
      <Box x={300} y={160} w={160} h={80} title="eir-simulator" sub="Elixir, Mint.WS" sub2="user-firing rig" />
      <Box x={580} y={100} w={140} h={80} title="postgres" sub=":16-alpine" sub2="private only" />

      {/* client → server (HTTPS/WSS) */}
      <Arrow x1={160} y1={130} x2={300} y2={75} label="HTTPS / WSS" />
      {/* client → simulator (HTTPS) */}
      <Arrow x1={160} y1={155} x2={300} y2={195} label="HTTPS trigger" />
      {/* simulator → server (WSS) */}
      <Arrow x1={380} y1={160} x2={380} y2={120} label="WSS load" />
      {/* server → postgres (TCP) */}
      <Arrow x1={460} y1={80} x2={580} y2={130} label="TCP" />
      {/* server ↔ server (cluster) */}
      <SelfArrow x={460} y={50} label="cluster mesh" />
    </svg>
  );
}

function HotPathDiagram() {
  const steps = [
    { id: "0", t: "ID mint", sub: "UUIDv7" },
    { id: "1", t: "ETS put", sub: "~5 µs" },
    { id: "2", t: "PubSub broadcast", sub: "~100 µs" },
    { id: "3", t: "cache:sync", sub: "cluster mirror" },
    { id: "4", t: "Broadway push", sub: "~1 µs" },
    { id: "5", t: "Repo.insert_all", sub: "~200 ms (batched)" },
  ];

  const w = 760;
  const h = 200;
  const boxW = 110;
  const boxH = 56;
  const gap = (w - boxW * steps.length) / (steps.length + 1);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <defs>
        <marker
          id="arr2"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#888" />
        </marker>
      </defs>

      {/* lane label */}
      <text x={20} y={22} fill="#888" fontSize={11} fontFamily="monospace">
        Chat.ingest/1
      </text>
      <line x1={20} y1={30} x2={w - 20} y2={30} stroke="#222" strokeDasharray="3,3" />

      {steps.map((s, i) => {
        const x = gap + i * (boxW + gap);
        const y = 70;
        return (
          <g key={s.id}>
            <rect
              x={x}
              y={y}
              width={boxW}
              height={boxH}
              fill="#0a0a0a"
              stroke={s.id === "5" ? "#3a4a3a" : "#333"}
              strokeWidth={1}
            />
            <text
              x={x + 8}
              y={y + 14}
              fill="#666"
              fontSize={9}
              fontFamily="monospace"
            >
              [ {s.id} ]
            </text>
            <text
              x={x + boxW / 2}
              y={y + 30}
              fill="#e0e0e0"
              fontSize={11}
              fontFamily="monospace"
              textAnchor="middle"
            >
              {s.t}
            </text>
            <text
              x={x + boxW / 2}
              y={y + 46}
              fill="#888"
              fontSize={10}
              fontFamily="monospace"
              textAnchor="middle"
            >
              {s.sub}
            </text>
            {i < steps.length - 1 && (
              <line
                x1={x + boxW}
                y1={y + boxH / 2}
                x2={x + boxW + gap}
                y2={y + boxH / 2}
                stroke="#888"
                strokeWidth={1}
                markerEnd="url(#arr2)"
              />
            )}
          </g>
        );
      })}

      {/* dashed line under steps 1-3 = "synchronous, fast" */}
      <line x1={gap} y1={150} x2={gap + 4 * (boxW + gap) - gap} y2={150} stroke="#3a3a3a" strokeDasharray="2,3" />
      <text x={gap + (4 * (boxW + gap) - gap) / 2} y={165} fill="#666" fontSize={10} textAnchor="middle" fontFamily="monospace">
        synchronous on the WS handler · sub-millisecond total
      </text>

      {/* dashed line under steps 4-5 = "asynchronous" */}
      <line x1={gap + 4 * (boxW + gap)} y1={150} x2={w - gap} y2={150} stroke="#3a3a3a" strokeDasharray="2,3" />
      <text x={gap + 4 * (boxW + gap) + (w - gap - (gap + 4 * (boxW + gap))) / 2} y={165} fill="#666" fontSize={10} textAnchor="middle" fontFamily="monospace">
        async, batched
      </text>
    </svg>
  );
}

function ClusterDiagram() {
  const cx = 380;
  const cy = 130;
  const r = 80;
  const labels = ["replica 1", "replica 2", "replica 3", "replica 4"];
  const positions = [0, 90, 180, 270].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  });

  return (
    <svg viewBox="0 0 760 320" width="100%" style={{ display: "block" }}>
      <defs>
        <marker
          id="arr3"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#666" />
        </marker>
      </defs>

      {/* mesh lines between replicas */}
      {positions.map((p, i) =>
        positions.slice(i + 1).map((q, j) => (
          <line
            key={`${i}-${j}`}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
            stroke="#3a3a3a"
            strokeWidth={1}
          />
        )),
      )}

      {/* replicas as boxes */}
      {positions.map((p, i) => (
        <g key={i}>
          <rect
            x={p.x - 60}
            y={p.y - 22}
            width={120}
            height={44}
            fill="#0a0a0a"
            stroke="#444"
          />
          <text
            x={p.x}
            y={p.y - 4}
            fill="#e0e0e0"
            fontSize={11}
            textAnchor="middle"
            fontFamily="monospace"
          >
            {labels[i]}
          </text>
          <text
            x={p.x}
            y={p.y + 12}
            fill="#888"
            fontSize={10}
            textAnchor="middle"
            fontFamily="monospace"
          >
            eir@&lt;ipv6&gt;
          </text>
        </g>
      ))}

      {/* center label */}
      <text x={cx} y={cy + 4} fill="#666" fontSize={10} textAnchor="middle" fontFamily="monospace">
        :pg / dns_cluster
      </text>

      {/* postgres at the bottom */}
      <line x1={cx} y1={cy + r + 22} x2={cx} y2={260} stroke="#666" strokeDasharray="2,3" />
      <rect x={cx - 80} y={260} width={160} height={42} fill="#0a0a0a" stroke="#333" />
      <text x={cx} y={278} fill="#e0e0e0" fontSize={11} textAnchor="middle" fontFamily="monospace">
        postgres
      </text>
      <text x={cx} y={293} fill="#888" fontSize={10} textAnchor="middle" fontFamily="monospace">
        shared, private
      </text>

      {/* legend */}
      <text x={20} y={28} fill="#666" fontSize={11} fontFamily="monospace">
        full mesh · every replica connects to every other over IPv6
      </text>
    </svg>
  );
}

// --- atoms ---

function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  sub2,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  sub2?: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="#0a0a0a"
        stroke={accent ? "#3a4a3a" : "#333"}
        strokeWidth={1}
      />
      <text
        x={x + w / 2}
        y={y + 22}
        fill="#e0e0e0"
        fontSize={12}
        textAnchor="middle"
        fontFamily="monospace"
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + 42}
          fill="#888"
          fontSize={10}
          textAnchor="middle"
          fontFamily="monospace"
        >
          {sub}
        </text>
      )}
      {sub2 && (
        <text
          x={x + w / 2}
          y={y + 58}
          fill="#666"
          fontSize={10}
          textAnchor="middle"
          fontFamily="monospace"
        >
          {sub2}
        </text>
      )}
    </g>
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="#888"
        strokeWidth={1}
        markerEnd="url(#arr)"
      />
      {label && (
        <text
          x={mx}
          y={my - 4}
          fill="#888"
          fontSize={10}
          textAnchor="middle"
          fontFamily="monospace"
        >
          {label}
        </text>
      )}
    </g>
  );
}

function SelfArrow({ x, y, label }: { x: number; y: number; label?: string }) {
  return (
    <g>
      <path
        d={`M ${x} ${y} q -50 -40 0 -50 q 60 0 0 50`}
        fill="none"
        stroke="#888"
        strokeWidth={1}
        markerEnd="url(#arr)"
      />
      {label && (
        <text x={x - 25} y={y - 35} fill="#888" fontSize={10} fontFamily="monospace">
          {label}
        </text>
      )}
    </g>
  );
}

function SVGWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #333",
        padding: 16,
        margin: "12px 0",
      }}
    >
      {children}
    </div>
  );
}

function H1({ children }: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        fontSize: 22,
        color: "#e0e0e0",
        margin: "8px 0 16px",
        fontWeight: "normal",
        letterSpacing: 1,
      }}
    >
      {children}
    </h1>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 14,
        color: "#c9a76a",
        margin: "32px 0 8px",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        fontWeight: "normal",
      }}
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 13,
        color: "#e0e0e0",
        margin: "20px 0 6px",
        fontWeight: "normal",
      }}
    >
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "8px 0", color: "#a8a8a8" }}>{children}</p>;
}

function B({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#e0e0e0" }}>{children}</span>;
}

function I({ children }: { children: React.ReactNode }) {
  return <em style={{ color: "#c9a76a", fontStyle: "normal" }}>{children}</em>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: "#0a0a0a",
        border: "1px solid #2a2a2a",
        padding: "1px 5px",
        color: "#d8d8d8",
        fontSize: 12,
      }}
    >
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre
      style={{
        background: "#0a0a0a",
        border: "1px solid #2a2a2a",
        padding: 12,
        margin: "10px 0",
        fontSize: 12,
        color: "#d8d8d8",
        overflow: "auto",
        lineHeight: 1.5,
      }}
    >
      {children}
    </pre>
  );
}

function Numbered({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: "10px 0" }}>{children}</div>;
}

function NumberedItem({
  n,
  t,
  children,
}: {
  n: string;
  t: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "32px 1fr",
        gap: 12,
        margin: "8px 0",
        padding: "6px 0",
        borderTop: "1px dotted #222",
      }}
    >
      <span style={{ color: "#666", fontSize: 11, paddingTop: 2 }}>[ {n} ]</span>
      <div>
        <div style={{ color: "#e0e0e0", fontSize: 12 }}>{t}</div>
        <div style={{ color: "#a8a8a8", marginTop: 2 }}>{children}</div>
      </div>
    </div>
  );
}

function Two({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10,
        margin: "10px 0",
      }}
    >
      {children}
    </div>
  );
}

function Card({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #333",
        padding: 12,
      }}
    >
      <div style={{ color: "#c9a76a", fontSize: 12, marginBottom: 4 }}>{t}</div>
      <div style={{ color: "#a8a8a8", fontSize: 12 }}>{children}</div>
    </div>
  );
}
