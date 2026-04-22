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
  // Two halves separated by a dashed vertical divider in the middle.
  // Each half: title, body (visual), 3-line caption block at the bottom.
  // Generous padding so nothing crowds anything.
  const W = 1100;
  const H = 460;
  const mid = W / 2;
  const halfW = mid - 20;             // each half occupies 0..mid-20 and mid+20..W
  const leftCenterX = halfW / 2 + 20;  // x center of the left half ~ 280
  const rightCenterX = mid + 20 + halfW / 2; // ~ 820

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <defs>
        <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="0.8" fill="#444" />
        </pattern>
      </defs>

      <line x1={mid} y1={20} x2={mid} y2={H - 20} stroke="#222" strokeDasharray="4,4" />

      {/* === LEFT === */}
      <text x={leftCenterX} y={36} fill="#e0e0e0" fontSize={16} textAnchor="middle" fontFamily="monospace">
        traditional OS thread per connection
      </text>
      <rect x={40} y={64} width={halfW - 40} height={240} fill="url(#dots)" stroke="#333" />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const cols = 3;
        const tw = 130;
        const th = 80;
        const innerLeft = 40 + 24;
        const innerTop = 64 + 24;
        const cellGapX = ((halfW - 40) - 48 - cols * tw) / (cols - 1); // distribute remaining horiz space
        const cellGapY = 16;
        const x = innerLeft + (i % cols) * (tw + cellGapX);
        const y = innerTop + Math.floor(i / cols) * (th + cellGapY);
        return (
          <g key={i}>
            <rect x={x} y={y} width={tw} height={th} fill="#0a0a0a" stroke="#5a4040" />
            <text x={x + tw / 2} y={y + 28} fill="#c0c0c0" fontSize={13} textAnchor="middle" fontFamily="monospace">
              thread #{i + 1}
            </text>
            <text x={x + tw / 2} y={y + 50} fill="#888" fontSize={11} textAnchor="middle" fontFamily="monospace">
              ~8 MB stack
            </text>
            <text x={x + tw / 2} y={y + 68} fill="#888" fontSize={11} textAnchor="middle" fontFamily="monospace">
              shared heap
            </text>
          </g>
        );
      })}
      <text x={leftCenterX} y={344} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        ~thousands max per box
      </text>
      <text x={leftCenterX} y={368} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        GC pauses every thread
      </text>
      <text x={leftCenterX} y={392} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        locks for shared state
      </text>

      {/* === RIGHT === */}
      <text x={rightCenterX} y={36} fill="#e0e0e0" fontSize={16} textAnchor="middle" fontFamily="monospace">
        BEAM process per connection
      </text>
      <rect x={mid + 40} y={64} width={halfW - 40} height={240} fill="url(#dots)" stroke="#3a4a3a" />
      {Array.from({ length: 96 }).map((_, i) => {
        const cols = 12;
        const cw = 28;
        const ch = 18;
        const innerLeft = mid + 40 + 24;
        const innerTop = 64 + 24;
        const cellGapX = ((halfW - 40) - 48 - cols * cw) / (cols - 1);
        const cellGapY = 4;
        const x = innerLeft + (i % cols) * (cw + cellGapX);
        const y = innerTop + Math.floor(i / cols) * (ch + cellGapY);
        return (
          <rect key={i} x={x} y={y} width={cw} height={ch} fill="#0a0a0a" stroke="#3a5a3a" strokeWidth={0.5} />
        );
      })}
      <text x={rightCenterX} y={344} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        each cell = 1 process · ~2 KB initial heap
      </text>
      <text x={rightCenterX} y={368} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        millions per VM · per-process heap, GC isolated
      </text>
      <text x={rightCenterX} y={392} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        no shared state · no locks
      </text>
    </svg>
  );
}

function ArchitectureDiagram() {
  // Layout rules used here (and in every diagram below):
  //   - viewBox is large (1100w) so absolute pixel sizes (~16px text)
  //     read normally on a real screen
  //   - boxes are tall (140h) and wide (260w), text is centered with
  //     22-24px line height, never within 16px of the box edge
  //   - arrow labels live in their own clear "lane" between boxes,
  //     offset 14-18px from the arrow itself so they never sit on it
  return (
    <svg viewBox="0 0 1100 380" width="100%" style={{ display: "block" }}>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#888" />
        </marker>
      </defs>

      {/* client (left) */}
      <NodeBox x={40}  y={130} w={240} title="client" lines={["React + TanStack", "static, nginx"]} />

      {/* eir-server (center top) — 3 stacked rects with replica cluster */}
      <g>
        <rect x={446} y={26} width={260} height={140} fill="#0a0a0a" stroke="#3a4a3a" />
        <rect x={433} y={13} width={260} height={140} fill="#0a0a0a" stroke="#3a4a3a" />
        <rect x={420} y={0}  width={260} height={140} fill="#0a0a0a" stroke="#3a4a3a" />
        <text x={550} y={36}  fill="#e0e0e0" fontSize={16} textAnchor="middle" fontFamily="monospace">eir-server</text>
        <text x={550} y={62}  fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">Phoenix · BEAM</text>
        <text x={550} y={86}  fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">× N replicas</text>
        <text x={550} y={114} fill="#3a8a3a" fontSize={11} textAnchor="middle" fontFamily="monospace">internal cluster mesh</text>
      </g>

      {/* eir-simulator (center bottom) */}
      <NodeBox x={420} y={230} w={260} title="eir-simulator" lines={["Elixir + Mint.WebSocket", "user-firing rig"]} />

      {/* postgres (right) */}
      <NodeBox x={820} y={130} w={240} title="postgres" lines={[":16-alpine", "private network only"]} />

      {/* arrows */}
      <ArrowLabel x1={280} y1={170} x2={420} y2={88}  label="HTTPS / WSS"   labelX={350} labelY={120} />
      <ArrowLabel x1={280} y1={210} x2={420} y2={272} label="HTTPS trigger" labelX={350} labelY={258} />
      <ArrowLabel x1={550} y1={230} x2={550} y2={146} label="WSS load"      labelX={580} labelY={195} />
      <ArrowLabel x1={680} y1={88}  x2={820} y2={180} label="TCP"           labelX={760} labelY={120} />
    </svg>
  );
}

function HotPathDiagram() {
  // Six steps wrapped to two rows of three. Each box is 280×100 with
  // generous internal padding so the labels never crowd the borders.
  const steps = [
    { id: "0", t: "ID mint",          sub: "UUIDv7, time-ordered" },
    { id: "1", t: "ETS put",          sub: "~5 µs · local cache" },
    { id: "2", t: "PubSub broadcast", sub: "~100 µs · cluster-wide" },
    { id: "3", t: "cache:sync",       sub: "mirror to all replicas" },
    { id: "4", t: "Broadway push",    sub: "~1 µs · into batch buffer" },
    { id: "5", t: "Repo.insert_all",  sub: "~200 ms · batched SQL" },
  ];

  const boxW = 280;
  const boxH = 100;
  const colGap = 50;
  const rowGap = 80;
  const leftPad = 40;
  const topPad = 50;

  return (
    <svg viewBox="0 0 1100 380" width="100%" style={{ display: "block" }}>
      <defs>
        <marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#888" />
        </marker>
      </defs>

      {/* lane title */}
      <text x={leftPad} y={28} fill="#a8a8a8" fontSize={13} fontFamily="monospace">
        Chat.ingest/1 — what one message goes through
      </text>

      {steps.map((s, i) => {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const x = leftPad + col * (boxW + colGap);
        const y = topPad + row * (boxH + rowGap);
        const isLast = s.id === "5";
        return (
          <g key={s.id}>
            <rect x={x} y={y} width={boxW} height={boxH} fill="#0a0a0a" stroke={isLast ? "#3a4a3a" : "#333"} />
            <text x={x + 16} y={y + 24} fill="#666" fontSize={12} fontFamily="monospace">[ {s.id} ]</text>
            <text x={x + boxW / 2} y={y + 54} fill="#e0e0e0" fontSize={16} textAnchor="middle" fontFamily="monospace">{s.t}</text>
            <text x={x + boxW / 2} y={y + 80} fill="#a8a8a8" fontSize={12} textAnchor="middle" fontFamily="monospace">{s.sub}</text>

            {/* horizontal arrow to next box in same row */}
            {col < 2 && (
              <line
                x1={x + boxW + 4} y1={y + boxH / 2}
                x2={x + boxW + colGap - 4} y2={y + boxH / 2}
                stroke="#888" strokeWidth={1.2} markerEnd="url(#arr2)"
              />
            )}
          </g>
        );
      })}

      {/* curved arrow from end of row 1 to start of row 2 */}
      {(() => {
        const r1End = { x: leftPad + 3 * boxW + 2 * colGap, y: topPad + boxH / 2 };
        const r2Start = { x: leftPad, y: topPad + boxH + rowGap + boxH / 2 };
        return (
          <g>
            <path
              d={`M ${r1End.x} ${r1End.y} C ${r1End.x + 30} ${r1End.y}, ${r1End.x + 30} ${(r1End.y + r2Start.y) / 2}, ${(r1End.x + r2Start.x) / 2} ${(r1End.y + r2Start.y) / 2} S ${r2Start.x - 30} ${r2Start.y}, ${r2Start.x - 4} ${r2Start.y}`}
              fill="none" stroke="#888" strokeWidth={1.2} markerEnd="url(#arr2)"
            />
          </g>
        );
      })()}

      {/* lane separator + captions */}
      <line x1={leftPad} y1={topPad + boxH + rowGap / 2 - 8} x2={leftPad + 3 * boxW + 2 * colGap} y2={topPad + boxH + rowGap / 2 - 8} stroke="#222" strokeDasharray="3,3" />
      <text x={550} y={topPad + boxH + 24} fill="#a8a8a8" fontSize={12} textAnchor="middle" fontFamily="monospace">
        ↑ synchronous · sub-millisecond  ·  ↓ async · batched persist
      </text>
    </svg>
  );
}

function ClusterDiagram() {
  // Horizontal row of 4 replica boxes. Mesh edges drawn as arcs ABOVE
  // them so they never cross the box content. Postgres centered below
  // with one arrow joining the row to it.
  const replicaW = 200;
  const replicaH = 80;
  const gap = 30;
  const totalW = 4 * replicaW + 3 * gap;
  const startX = (1100 - totalW) / 2;
  const replicaY = 160;
  const centers = [0, 1, 2, 3].map((i) => ({
    x: startX + i * (replicaW + gap) + replicaW / 2,
    y: replicaY + replicaH / 2,
  }));

  return (
    <svg viewBox="0 0 1100 460" width="100%" style={{ display: "block" }}>
      <defs>
        <marker id="arr3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#666" />
        </marker>
      </defs>

      <text x={startX} y={36} fill="#a8a8a8" fontSize={13} fontFamily="monospace">
        4 replicas, full mesh over IPv6
      </text>
      <text x={startX} y={56} fill="#888" fontSize={12} fontFamily="monospace">
        dns_cluster polls the service domain · :pg distributes broadcasts
      </text>

      {/* mesh arcs above the row — every pair of replicas */}
      {centers.map((p, i) =>
        centers.slice(i + 1).map((q, j) => {
          const midX = (p.x + q.x) / 2;
          const peakY = replicaY - 28 - 18 * (j + i); // higher arc for non-adjacent pairs
          const path = `M ${p.x} ${replicaY} Q ${midX} ${peakY} ${q.x} ${replicaY}`;
          return <path key={`${i}-${j}`} d={path} fill="none" stroke="#3a4a3a" strokeWidth={1} />;
        }),
      )}

      {/* replica boxes */}
      {centers.map((p, i) => (
        <g key={i}>
          <rect x={p.x - replicaW / 2} y={replicaY} width={replicaW} height={replicaH} fill="#0a0a0a" stroke="#444" />
          <text x={p.x} y={replicaY + 32} fill="#e0e0e0" fontSize={15} textAnchor="middle" fontFamily="monospace">
            replica {i + 1}
          </text>
          <text x={p.x} y={replicaY + 56} fill="#888" fontSize={12} textAnchor="middle" fontFamily="monospace">
            eir@&lt;ipv6&gt;
          </text>
        </g>
      ))}

      {/* postgres at bottom, single arrow joining the row */}
      <rect x={(1100 - 280) / 2} y={360} width={280} height={70} fill="#0a0a0a" stroke="#333" />
      <text x={550} y={388} fill="#e0e0e0" fontSize={15} textAnchor="middle" fontFamily="monospace">
        postgres
      </text>
      <text x={550} y={410} fill="#888" fontSize={12} textAnchor="middle" fontFamily="monospace">
        shared, private network
      </text>

      {/* one arrow from the row's center to postgres */}
      <line x1={550} y1={replicaY + replicaH + 6} x2={550} y2={356} stroke="#666" strokeWidth={1.2} markerEnd="url(#arr3)" />
      <text x={566} y={310} fill="#888" fontSize={12} fontFamily="monospace">
        TCP · ecto pool per replica
      </text>
    </svg>
  );
}

// --- atoms ---

// A labelled box. Title at the top, optional lines stacked below. Lines
// are rendered at fixed 24px intervals so we never collide with borders.
function NodeBox({
  x,
  y,
  w,
  title,
  lines = [],
}: {
  x: number;
  y: number;
  w: number;
  title: string;
  lines?: string[];
}) {
  const h = 44 + Math.max(0, lines.length) * 24 + 24;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="#0a0a0a" stroke="#333" />
      <text x={x + w / 2} y={y + 32} fill="#e0e0e0" fontSize={16} textAnchor="middle" fontFamily="monospace">
        {title}
      </text>
      {lines.map((line, i) => (
        <text
          key={i}
          x={x + w / 2}
          y={y + 56 + i * 24}
          fill="#a8a8a8"
          fontSize={13}
          textAnchor="middle"
          fontFamily="monospace"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// Arrow with its label positioned at an explicit (labelX, labelY). This
// avoids the common failure where a computed midpoint puts the label
// exactly on top of the arrow line.
function ArrowLabel({
  x1,
  y1,
  x2,
  y2,
  label,
  labelX,
  labelY,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  labelX: number;
  labelY: number;
}) {
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#888" strokeWidth={1.2} markerEnd="url(#arr)" />
      <text x={labelX} y={labelY} fill="#a8a8a8" fontSize={13} textAnchor="middle" fontFamily="monospace">
        {label}
      </text>
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
        gridTemplateColumns: "52px 1fr",
        gap: 12,
        margin: "8px 0",
        padding: "6px 0",
        borderTop: "1px dotted #222",
      }}
    >
      <span
        style={{
          color: "#666",
          fontSize: 11,
          paddingTop: 2,
          whiteSpace: "nowrap",
        }}
      >
        [ {n} ]
      </span>
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
