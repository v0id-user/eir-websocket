import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Snapshot, type SimSnapshot, type LatencyHist } from "../lib/api";
import { joinMetrics } from "../lib/socket";
import { getNickname } from "../lib/nickname";
import { SOCKET_URL } from "../lib/config";

type NodeMap = Record<string, Snapshot>;

const HISTORY_LEN = 30;

export function Dashboard() {
  const [byNode, setByNode] = useState<NodeMap>({});
  const [sim, setSim] = useState<SimSnapshot | null>(null);
  const [history, setHistory] = useState<
    { at: number; in: number; persisted: number }[]
  >([]);

  // rAF-batch incoming metric snapshots: many ticks within a frame collapse
  // into one setState. With 4 replicas at 3.3Hz we get ~13 events/sec; the
  // browser's JS allocation churn from re-rendering the whole tree on each
  // was the main driver of the heap growing 350MB→800MB during long runs.
  const pendingRef = useRef<Map<string, Snapshot>>(new Map());
  const aliveRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const ch = joinMetrics(getNickname());

    const flush = () => {
      rafRef.current = null;
      const incoming = pendingRef.current;
      const alive = aliveRef.current;
      if (incoming.size === 0) return;
      pendingRef.current = new Map();
      aliveRef.current = new Set();

      setByNode((m) => {
        const next: NodeMap = {};
        // carry over only nodes that are still alive per the latest cluster
        for (const [n, snap] of Object.entries(m)) {
          if (alive.has(n)) next[n] = snap;
        }
        for (const [n, snap] of incoming) {
          next[n] = snap;
        }
        return next;
      });
    };

    const apply = (payload: Snapshot) => {
      pendingRef.current.set(payload.node, payload);
      aliveRef.current = new Set(payload.cluster ?? []);
      aliveRef.current.add(payload.node);
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
    };

    ch.on("snapshot", apply);
    ch.on("tick", apply);
    ch.join();
    return () => {
      ch.leave();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = new Map();
      aliveRef.current = new Set();
    };
  }, []);

  // Aggregate across nodes, update history chart tick
  const agg = useMemo(() => aggregate(byNode), [byNode]);

  useEffect(() => {
    if (!agg) return;
    setHistory((h) => {
      const next = h.length >= HISTORY_LEN ? h.slice(-(HISTORY_LEN - 1)) : h;
      return [
        ...next,
        { at: agg.at_ms, in: agg.rate_in, persisted: agg.rate_persisted },
      ];
    });
  }, [agg?.at_ms]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        setSim(await api.sim.stats());
      } catch {
        setSim(null);
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ padding: 12, maxWidth: 1600, margin: "0 auto" }}>
      <div
        style={{
          fontSize: 11,
          color: "#888",
          padding: "4px 8px",
          borderBottom: "1px solid #333",
          marginBottom: 12,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>/dashboard</span>
        <span>
          cluster: {Object.keys(byNode).length} node
          {Object.keys(byNode).length !== 1 ? "s" : ""} . uptime:{" "}
          {agg ? fmtDuration(agg.uptime_s) : "-"}
        </span>
      </div>

      <StatGrid>
        <Stat
          label="msgs/sec in"
          value={fmt(agg?.rate_in)}
          tip="messages per second the cluster is INGESTING (sum across all replicas). Each Chat.ingest call counts once."
        />
        <Stat
          label="msgs/sec persisted"
          value={fmt(agg?.rate_persisted)}
          tip="rows per second Broadway is INSERTing into Postgres (cluster-wide). Should track ingest closely; if it lags, the queue depth grows."
        />
        <Stat
          label="queue depth"
          value={agg?.queue_depth ?? "-"}
          tip="messages waiting in Broadway's buffer to be batched and persisted. Cluster-wide sum. Stays near 0 in healthy steady state."
        />
        <Stat
          label="ws connections"
          value={agg?.connections ?? "-"}
          tip="live Phoenix.Channel processes (one per connected WS) across the cluster. ~= number of connected clients."
        />
        <Stat
          label="total cached"
          value={agg?.cache_total ?? "-"}
          tip="message rows held in per-node ETS ring buffers. Capped at 200 per group per node; cluster-wide total = sum across replicas."
        />
        <Stat
          label="processes"
          value={agg ? `${agg.processes}` : "-"}
          sub={agg ? `of ${fmt(agg.processes_limit)}` : ""}
          tip="Erlang processes alive cluster-wide. Each WS connection ≈ 1 channel process. BEAM default limit per node is 1M+."
        />
        <Stat
          label="memory total"
          value={agg ? `${agg.memory_mb.toFixed(0)}mb` : "-"}
          sub={
            agg
              ? `proc ${agg.memory_processes_mb.toFixed(0)} . bin ${agg.memory_binary_mb.toFixed(0)}`
              : ""
          }
          tip="resident BEAM heap cluster-wide (sum). Sub-line shows process heap + binary heap totals."
        />
        <Stat
          label="run queue"
          value={agg?.run_queue ?? "-"}
          tip="processes waiting for a scheduler right now (cluster-wide). >0 sustained = CPU-bound."
        />
      </StatGrid>

      <div style={{ height: 1 }} />

      <StatGrid>
        <Stat
          label="reductions/s"
          value={fmt(agg?.rate_reductions)}
          sub={agg ? `${fmt(agg.reductions_total)} total` : ""}
          tip="BEAM scheduler 'reductions' per second across the cluster. ~1 reduction = 1 unit of work (function call, send, etc). Idle BEAM ≈ 100k/s/node, busy = millions+. The native unit of how much the runtime is doing."
        />
        <Stat
          label="atoms"
          value={agg ? fmt(agg.atoms) : "-"}
          sub={agg ? `of ${fmt(agg.atoms_limit)}` : ""}
          tip="atom table size. Atoms are interned and never GC'd; should stay flat in production. Growth = a leak."
        />
        <Stat
          label="ports"
          value={agg ? `${agg.ports}` : "-"}
          sub={agg ? `of ${fmt(agg.ports_limit)}` : ""}
          tip="open Erlang ports cluster-wide. Each TCP/WS socket and external program is a port."
        />
        <Stat
          label="ets tables"
          value={agg ? `${agg.ets_tables}` : "-"}
          sub={agg ? `${agg.memory_ets_mb.toFixed(1)}mb` : ""}
          tip="ETS table count + total ETS memory. Phoenix internals + app caches all live here."
        />
        <Stat
          label="binary mem"
          value={agg ? `${agg.memory_binary_mb.toFixed(1)}mb` : "-"}
          tip="reference-counted binary heap. Strings/JSON > 64 bytes live here. Big growth = held references somewhere."
        />
        <Stat
          label="code mem"
          value={agg ? `${agg.memory_code_mb.toFixed(1)}mb` : "-"}
          tip="loaded BEAM bytecode. Stays flat unless you hot-load modules at runtime."
        />
        <Stat
          label="io in/out"
          value={agg ? `${agg.io_in_mb.toFixed(0)}/${agg.io_out_mb.toFixed(0)}mb` : "-"}
          tip="cumulative bytes the BEAM has read / written through ports. Includes WS, DB connections, etc."
        />
        <Stat
          label="schedulers"
          value={agg ? `${agg.schedulers}` : "-"}
          tip="online normal schedulers per node. BEAM also runs dirty CPU + dirty IO schedulers separately."
        />
      </StatGrid>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <Panel title="throughput [60s]">
          <Chart
            history={history}
            series={[
              { key: "in", label: "msgs/s in", color: "#c0c0c0" },
              { key: "persisted", label: "msgs/s persisted", color: "#707070" },
            ]}
          />
        </Panel>
        <Panel title={`nodes [${Object.keys(byNode).length}]`}>
          <NodeTable byNode={byNode} />
        </Panel>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Panel title="latency: ingest → broadcast">
          <LatencyPanel byNode={byNode} kind="broadcast" />
        </Panel>
        <Panel title="latency: ingest → persisted">
          <LatencyPanel byNode={byNode} kind="persist" />
        </Panel>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Panel title="schedulers">
          <SchedulersHeatmap byNode={byNode} />
        </Panel>
        <Panel title="cache by group">
          <BarList entries={Object.entries(agg?.cache_groups ?? {})} />
        </Panel>
      </div>

      <div style={{ marginTop: 12 }}>
        <Panel title="ingest heatmap · node × group">
          <IngestHeatmap byNode={byNode} />
        </Panel>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Panel title="simulator">
          <SimControls sim={sim} />
        </Panel>
        <Panel title="chaos">
          <ChaosControls byNode={byNode} />
        </Panel>
      </div>
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 1,
        background: "#333",
        border: "1px solid #333",
      }}
    >
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tip,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tip?: string;
}) {
  return (
    <div
      style={{ background: "#0a0a0a", padding: "6px 10px", minHeight: 56 }}
      title={tip}
    >
      <div
        style={{
          fontSize: 9,
          color: "#666",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, color: "#e0e0e0", marginTop: 2 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 9, color: "#555", marginTop: 1 }}>{sub}</div>
      )}
    </div>
  );
}

const Panel = memo(function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "#0a0a0a", border: "1px solid #333" }}>
      <div
        style={{
          fontSize: 10,
          color: "#888",
          textTransform: "uppercase",
          padding: "4px 10px",
          borderBottom: "1px solid #333",
          background: "#141414",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
});

const NodeTable = memo(NodeTableImpl);

function NodeTableImpl({ byNode }: { byNode: NodeMap }) {
  const nodes = Object.entries(byNode).sort();
  if (nodes.length === 0) {
    return <div style={{ color: "#555", fontSize: 11 }}>... waiting</div>;
  }
  return (
    <div style={{ fontSize: 11 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
          color: "#666",
          fontSize: 10,
          padding: "2px 0",
          borderBottom: "1px solid #222",
          textTransform: "uppercase",
        }}
      >
        <span>node</span>
        <span style={{ textAlign: "right" }}>msgs/s</span>
        <span style={{ textAlign: "right" }}>conns</span>
        <span style={{ textAlign: "right" }}>procs</span>
        <span style={{ textAlign: "right" }}>mem</span>
      </div>
      {nodes.map(([name, s]) => (
        <div
          key={name}
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
            padding: "3px 0",
            borderBottom: "1px dotted #1a1a1a",
          }}
        >
          <span style={{ color: "#c0c0c0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </span>
          <span style={{ textAlign: "right", color: "#a0a0a0" }}>
            {fmt(s.rates?.ingest_received)}
          </span>
          <span style={{ textAlign: "right", color: "#a0a0a0" }}>
            {s.connections ?? 0}
          </span>
          <span style={{ textAlign: "right", color: "#a0a0a0" }}>
            {s.system?.processes ?? 0}
          </span>
          <span style={{ textAlign: "right", color: "#a0a0a0" }}>
            {s.system?.memory_mb?.toFixed(0) ?? 0}mb
          </span>
        </div>
      ))}
    </div>
  );
}

function fmt(n: number | undefined | null): string {
  if (n == null) return "-";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function aggregate(byNode: NodeMap) {
  const nodes = Object.values(byNode);
  if (nodes.length === 0) return null;

  const sum = (f: (s: Snapshot) => number) =>
    nodes.reduce((a, s) => a + (f(s) || 0), 0);
  const max = (f: (s: Snapshot) => number) =>
    nodes.reduce((a, s) => Math.max(a, f(s) || 0), 0);

  const cacheGroups: Record<string, number> = {};
  for (const s of nodes) {
    for (const [g, c] of Object.entries(s.cache?.groups || {})) {
      cacheGroups[g] = (cacheGroups[g] || 0) + c;
    }
  }

  const last = nodes.reduce((a, s) => (s.at_ms > a.at_ms ? s : a), nodes[0]);

  return {
    at_ms: last.at_ms,
    rate_in: sum((s) => s.rates?.ingest_received || 0),
    rate_persisted: sum((s) => s.rates?.batch_persisted || 0),
    rate_reductions: sum((s) => s.rates?.reductions || 0),
    queue_depth: sum((s) => s.pipeline?.queue_depth || 0),
    connections: sum((s) => s.connections || 0),
    cache_total: sum((s) => s.cache?.total || 0),
    cache_groups: cacheGroups,
    processes: sum((s) => s.system?.processes || 0),
    processes_limit: max((s) => s.system?.processes_limit || 0),
    atoms: max((s) => s.system?.atoms || 0),
    atoms_limit: max((s) => s.system?.atoms_limit || 0),
    ports: sum((s) => s.system?.ports || 0),
    ports_limit: max((s) => s.system?.ports_limit || 0),
    ets_tables: sum((s) => s.system?.ets_tables || 0),
    memory_mb: sum((s) => s.system?.memory_mb || 0),
    memory_processes_mb: sum((s) => s.system?.memory_processes_mb || 0),
    memory_binary_mb: sum((s) => s.system?.memory_binary_mb || 0),
    memory_ets_mb: sum((s) => s.system?.memory_ets_mb || 0),
    memory_code_mb: sum((s) => s.system?.memory_code_mb || 0),
    schedulers: max((s) => s.system?.schedulers || 0),
    run_queue: sum((s) => s.system?.run_queue || 0),
    reductions_total: sum((s) => s.system?.reductions_total || 0),
    io_in_mb: sum((s) => s.system?.io_in_mb || 0),
    io_out_mb: sum((s) => s.system?.io_out_mb || 0),
    uptime_s: max((s) => s.system?.uptime_s || 0),
  };
}

function Chart({
  history,
  series,
}: {
  history: { at: number; in: number; persisted: number }[];
  series: { key: "in" | "persisted"; label: string; color: string }[];
}) {
  const w = 600;
  const h = 180;
  if (history.length < 2) {
    return <div style={{ color: "#555", fontSize: 12 }}>... gathering data</div>;
  }
  const max = Math.max(
    1,
    ...history.flatMap((p) => series.map((x) => p[x.key] || 0)),
  );
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <rect x={0} y={0} width={w} height={h} fill="none" stroke="#222" strokeWidth={1} />
      {[0.25, 0.5, 0.75].map((p) => (
        <line
          key={p}
          x1={0}
          x2={w}
          y1={h * p}
          y2={h * p}
          stroke="#1a1a1a"
          strokeDasharray="2,3"
        />
      ))}
      {series.map((s) => {
        const pts = history.map((snap, i) => {
          const v = snap[s.key] || 0;
          const x = (i / (history.length - 1)) * w;
          const y = h - (v / max) * h;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        return (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={1}
            points={pts.join(" ")}
          />
        );
      })}
      {series.map((s, i) => (
        <text
          key={s.key}
          x={8}
          y={14 + i * 12}
          fill={s.color}
          fontSize={10}
          style={{ fontFamily: "monospace" }}
        >
          {s.label}
        </text>
      ))}
      <text x={w - 8} y={12} textAnchor="end" fill="#555" fontSize={10}>
        max {max.toFixed(0)}/s
      </text>
    </svg>
  );
}

function BarList({ entries }: { entries: [string, number][] }) {
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {entries
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k, v]) => (
          <div
            key={k}
            style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ width: 80, color: "#888" }}>{k}</span>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "#161616",
                border: "1px solid #222",
              }}
            >
              <div
                style={{
                  width: `${(v / total) * 100}%`,
                  height: "100%",
                  background: "#5a5a5a",
                }}
              />
            </div>
            <span style={{ width: 50, textAlign: "right", color: "#c0c0c0" }}>
              {v}
            </span>
          </div>
        ))}
    </div>
  );
}

const IngestHeatmap = memo(IngestHeatmapImpl);

function IngestHeatmapImpl({ byNode }: { byNode: NodeMap }) {
  const nodes = Object.entries(byNode).sort();
  if (nodes.length === 0) {
    return <div style={{ color: "#555", fontSize: 11 }}>... waiting</div>;
  }

  // Union of all groups seen across all nodes, sorted alphabetically
  const groupSet = new Set<string>();
  for (const [, s] of nodes) {
    Object.keys(s.ingest_by_group || {}).forEach((g) => groupSet.add(g));
  }
  const groups = [...groupSet].sort();

  if (groups.length === 0) {
    return (
      <div style={{ color: "#555", fontSize: 11 }}>
        ... no ingest yet, fire a run to see the cells light up
      </div>
    );
  }

  // Find global max for normalization
  let max = 0;
  for (const [, s] of nodes) {
    for (const v of Object.values(s.ingest_by_group || {})) {
      if (v > max) max = v;
    }
  }
  max = Math.max(max, 1);

  return (
    <div style={{ fontSize: 10 }}>
      <div style={{ color: "#666", marginBottom: 6 }}>
        messages ingested per (node, group) since last reset. each cell is the count;
        color intensity relative to global max.
      </div>
      <div style={{ overflow: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 10,
            fontFamily: "inherit",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  color: "#666",
                  padding: "2px 6px",
                  borderBottom: "1px solid #222",
                }}
              >
                node
              </th>
              {groups.map((g) => (
                <th
                  key={g}
                  style={{
                    color: "#888",
                    padding: "2px 6px",
                    borderBottom: "1px solid #222",
                    fontWeight: "normal",
                    minWidth: 50,
                  }}
                >
                  {g}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map(([name, s]) => (
              <tr key={name}>
                <td
                  style={{
                    color: "#888",
                    padding: "2px 6px",
                    borderRight: "1px solid #222",
                    whiteSpace: "nowrap",
                  }}
                >
                  {shortNode(name)}
                </td>
                {groups.map((g) => {
                  const v = s.ingest_by_group?.[g] || 0;
                  const pct = v / max;
                  // Cap lightness at ~28% and saturation at ~45% so cells
                  // stay in the dark-green range that #d8d8d8 text reads
                  // against. Pure neon green at 60% lightness fails contrast.
                  const lightness = 6 + Math.round(pct * 22);
                  const saturation = Math.round(pct * 45);
                  const bg =
                    v === 0 ? "#0f0f0f" : `hsl(120, ${saturation}%, ${lightness}%)`;
                  return (
                    <td
                      key={g}
                      title={`${name} · ${g}: ${v}`}
                      style={{
                        background: bg,
                        color: v === 0 ? "#333" : "#d8d8d8",
                        padding: "4px 6px",
                        textAlign: "center",
                        border: "1px solid #1a1a1a",
                        minWidth: 50,
                      }}
                    >
                      {fmt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LatencyPanel = memo(LatencyPanelImpl);

function LatencyPanelImpl({
  byNode,
  kind,
}: {
  byNode: NodeMap;
  kind: "broadcast" | "persist";
}) {
  const nodes = Object.values(byNode);
  if (nodes.length === 0) {
    return <div style={{ color: "#555", fontSize: 11 }}>... waiting</div>;
  }

  // Merge buckets across nodes
  const bucketMap = new Map<number, number>();
  let count = 0;
  let maxUs = 0;
  let sumP50 = 0,
    sumP99 = 0,
    sumP999 = 0,
    n = 0;

  for (const s of nodes) {
    const h: LatencyHist | undefined = s.latency?.[kind];
    if (!h) continue;
    count += h.count;
    maxUs = Math.max(maxUs, h.max_us);
    sumP50 += h.p50_us;
    sumP99 += h.p99_us;
    sumP999 += h.p999_us;
    n += 1;
    for (const b of h.buckets) {
      bucketMap.set(b.le_us, (bucketMap.get(b.le_us) || 0) + b.count);
    }
  }

  const buckets = Array.from(bucketMap.entries()).sort((a, b) => a[0] - b[0]);
  const maxCount = Math.max(1, ...buckets.map(([, c]) => c));

  const p50 = n > 0 ? sumP50 / n : 0;
  const p99 = n > 0 ? sumP99 / n : 0;
  const p999 = n > 0 ? sumP999 / n : 0;

  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 8, color: "#888" }}>
        <span>p50 {fmtUs(p50)}</span>
        <span>p99 {fmtUs(p99)}</span>
        <span>p999 {fmtUs(p999)}</span>
        <span>max {fmtUs(maxUs)}</span>
        <span style={{ marginLeft: "auto" }}>n {fmt(count)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 80 }}>
        {buckets.map(([edge, c]) => {
          const h = c === 0 ? 1 : Math.max(1, (c / maxCount) * 80);
          return (
            <div
              key={edge}
              title={`≤${fmtUs(edge)}: ${c}`}
              style={{
                flex: 1,
                height: h,
                background: c === 0 ? "#1a1a1a" : "#5a5a5a",
                border: "1px solid #222",
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 2,
          color: "#555",
          fontSize: 9,
        }}
      >
        <span>{fmtUs(buckets[0]?.[0] ?? 0)}</span>
        <span>{fmtUs(buckets[buckets.length - 1]?.[0] ?? 0)}</span>
      </div>
    </div>
  );
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

const SchedulersHeatmap = memo(SchedulersHeatmapImpl);

function SchedulersHeatmapImpl({ byNode }: { byNode: NodeMap }) {
  const nodes = Object.entries(byNode).sort();
  if (nodes.length === 0) {
    return <div style={{ color: "#555", fontSize: 11 }}>... waiting</div>;
  }

  // Only show the "normal" schedulers (the ones that matter for regular
  // work), not dirty-CPU or dirty-IO schedulers. system.schedulers tells us
  // how many are online; we take that many from the front of schedulers_util.
  const online = Math.max(
    1,
    ...nodes.map(([, s]) => s.system?.schedulers || 0),
  );

  return (
    <div style={{ fontSize: 10 }}>
      <div style={{ color: "#666", marginBottom: 6 }}>
        per-scheduler utilization % · {online} online schedulers/node · dark=idle → bright=busy
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {nodes.map(([name, s]) => {
          const cells = (s.schedulers_util ?? []).slice(0, online);
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 160,
                  color: "#888",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  flexShrink: 0,
                }}
                title={name}
              >
                {shortNode(name)}
              </span>
              <div style={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                {cells.map((c, i) => {
                  const pct = c?.pct ?? 0;
                  const lightness = 5 + Math.round((pct / 100) * 60);
                  const bg = `hsl(120, ${Math.round(pct)}%, ${lightness}%)`;
                  return (
                    <div
                      key={i}
                      title={`s${c.id}: ${pct.toFixed(1)}%`}
                      style={{
                        width: 18,
                        height: 14,
                        background: bg,
                        border: "1px solid #222",
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function shortNode(n: string): string {
  // turn "eir@fd12:86cf:49cd:1:4000:ca:cf67:79a6" into "…ca:cf67:79a6"
  const parts = n.split(":");
  if (parts.length > 3) return "…" + parts.slice(-3).join(":");
  return n;
}

function ChaosControls({ byNode }: { byNode: NodeMap }) {
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const nodes = Object.keys(byNode).sort();
  const singleNode = nodes.length <= 1;

  async function kill(victim?: string) {
    setBusy(true);
    setStatus(`> killing ${victim ?? "random node"}...`);
    try {
      const r = await api.chaos(victim);
      setStatus(`> killed ${r.killed} in ${r.in_ms}ms · railway will auto-restart`);
    } catch (e) {
      setStatus(`> error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
      <div style={{ color: "#888" }}>
        kill a replica and watch the cluster heal. railway restarts the
        container, dns_cluster rejoins it, phoenix.pubsub reconnects. nodes
        panel shrinks then grows back over ~6 seconds.
      </div>
      {singleNode && (
        <div
          style={{
            color: "#c9a76a",
            fontSize: 11,
            background: "#1a1613",
            border: "1px solid #2a221a",
            padding: "6px 8px",
          }}
          title="with one replica there's nobody to take over while it restarts. you'd just kill the whole service for ~10s. scale eir-server to 2+ replicas in the railway ui first."
        >
          ⚠ only 1 replica — chaos demo is moot. scale eir-server to 2+
          in the railway ui to see the cluster actually heal.
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => kill()}
          disabled={busy || nodes.length === 0 || singleNode}
          title={singleNode ? "scale to 2+ replicas first" : "kill a random replica"}
        >
          [ kill random ]
        </button>
        {nodes.map((n) => (
          <button
            key={n}
            onClick={() => kill(n)}
            disabled={busy || singleNode}
            title={singleNode ? "scale to 2+ replicas first" : n}
          >
            [ kill {shortNode(n)} ]
          </button>
        ))}
      </div>
      <div style={{ color: "#666", fontSize: 11, minHeight: 14 }}>{status}</div>
    </div>
  );
}

const SIM_PRESETS = [
  { name: "tiny",   connections: 10,   mps: 2,   duration: 15 },
  { name: "warm",   connections: 50,   mps: 5,   duration: 20 },
  { name: "normal", connections: 150,  mps: 8,   duration: 30 },
  { name: "spicy",  connections: 400,  mps: 10,  duration: 45 },
  { name: "stress", connections: 800,  mps: 12,  duration: 60 },
] as const;

const SIM_LIMITS = {
  connections: { min: 1,  max: 1500 },
  mps:         { min: 0,  max: 50   },
  duration:    { min: 1,  max: 120  },
};

// Soft thresholds for the "estimated load" preview shown under the inputs.
// Crossing them switches the line from gray to amber to red so you know
// you're about to ship a wall of messages before clicking [ run ].
const LOAD_WARN  = 250_000;
const LOAD_HEAVY = 1_000_000;

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

type RunSummary = {
  config: { connections: number; mps: number; duration: number };
  totalSent: number;
  totalRecv: number;
  errors: number;
  peakSent: number;
  peakRecv: number;
  fanout: number;
  endedAt: number;
};

function SimControls({ sim }: { sim: SimSnapshot | null }) {
  const [connections, setConnections] = useState(150);
  const [mps, setMps] = useState(8);
  const [duration, setDuration] = useState(30);
  const [status, setStatus] = useState<string>("");
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);

  const target = SOCKET_URL + "/websocket";
  const running = sim?.run != null;

  // Track peaks during a run, snapshot a summary when it ends
  const peakSentRef = useRef(0);
  const peakRecvRef = useRef(0);
  const wasRunningRef = useRef(false);
  const runConfigRef = useRef<{ connections: number; mps: number; duration: number } | null>(null);

  useEffect(() => {
    if (!sim) return;
    if (running) {
      peakSentRef.current = Math.max(peakSentRef.current, sim.rates.sent || 0);
      peakRecvRef.current = Math.max(peakRecvRef.current, sim.rates.received || 0);
      wasRunningRef.current = true;
    } else if (wasRunningRef.current) {
      // run just finished — snapshot final counters
      const totalSent = sim.counters.sent;
      const totalRecv = sim.counters.received;
      setLastRun({
        config: runConfigRef.current ?? { connections, mps, duration },
        totalSent,
        totalRecv,
        errors: sim.counters.send_errors,
        peakSent: peakSentRef.current,
        peakRecv: peakRecvRef.current,
        fanout: totalSent > 0 ? totalRecv / totalSent : 0,
        endedAt: sim.at_ms,
      });
      peakSentRef.current = 0;
      peakRecvRef.current = 0;
      wasRunningRef.current = false;
    }
  }, [sim, running, connections, mps, duration]);

  const liveFanout =
    sim && sim.rates.sent && sim.rates.sent > 0
      ? (sim.rates.received || 0) / sim.rates.sent
      : null;
  const perClientRate =
    sim && sim.counters.connected > sim.counters.disconnected && sim.rates.sent
      ? sim.rates.sent / (sim.counters.connected - sim.counters.disconnected)
      : null;

  const { data: presets } = useQuery({
    queryKey: ["presets"],
    queryFn: api.presets,
  });

  function applyPreset(p: typeof SIM_PRESETS[number]) {
    setConnections(p.connections);
    setMps(p.mps);
    setDuration(p.duration);
    setStatus(`> preset: ${p.name}`);
  }

  async function run() {
    const c = clamp(connections, SIM_LIMITS.connections.min, SIM_LIMITS.connections.max);
    const m = clamp(mps, SIM_LIMITS.mps.min, SIM_LIMITS.mps.max);
    const d = clamp(duration, SIM_LIMITS.duration.min, SIM_LIMITS.duration.max);
    setConnections(c); setMps(m); setDuration(d);
    runConfigRef.current = { connections: c, mps: m, duration: d };
    peakSentRef.current = 0;
    peakRecvRef.current = 0;
    setStatus("> starting...");
    try {
      const r = await api.sim.run({ target, connections: c, msgs_per_sec: m, duration: d });
      setStatus(r.ok ? `> running ${c}c × ${m}/s × ${d}s` : `> error: ${r.error}`);
    } catch (e) {
      setStatus(`> error: ${(e as Error).message}`);
    }
  }

  async function stop() {
    await api.sim.stop();
    setStatus("> stopped");
  }

  async function reset() {
    setStatus("> resetting...");
    await Promise.all([api.reset(), api.sim.reset().catch(() => {})]);
    setStatus("> db + cache + sim reset");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
      <div style={{ color: "#888" }}>
        target:{" "}
        <span style={{ color: "#c0c0c0", wordBreak: "break-all" }}>{target}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {SIM_PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => applyPreset(p)}
            disabled={running}
            title={`${p.connections} conns · ${p.mps}/s · ${p.duration}s`}
          >
            [ {p.name} ]
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center" }}>
        <label style={{ color: "#888" }}>connections</label>
        <input
          type="number"
          min={SIM_LIMITS.connections.min}
          max={SIM_LIMITS.connections.max}
          value={connections}
          onChange={(e) => setConnections(+e.target.value)}
        />
        <label style={{ color: "#888" }}>msgs/sec each</label>
        <input
          type="number"
          min={SIM_LIMITS.mps.min}
          max={SIM_LIMITS.mps.max}
          value={mps}
          onChange={(e) => setMps(+e.target.value)}
        />
        <label style={{ color: "#888" }}>duration (s)</label>
        <input
          type="number"
          min={SIM_LIMITS.duration.min}
          max={SIM_LIMITS.duration.max}
          value={duration}
          onChange={(e) => setDuration(+e.target.value)}
        />
      </div>
      <div style={{ fontSize: 10, color: "#555" }}>
        max: {SIM_LIMITS.connections.max} conns · {SIM_LIMITS.mps.max}/s · {SIM_LIMITS.duration.max}s
      </div>
      {(() => {
        const est = Math.max(0, connections) * Math.max(0, mps) * Math.max(0, duration);
        const tone =
          est >= LOAD_HEAVY ? "#d96a4a" : est >= LOAD_WARN ? "#c9a76a" : "#666";
        const note =
          est >= LOAD_HEAVY ? " — heavy, persistence + WS fan-out will work" :
          est >= LOAD_WARN  ? " — substantial, postgres rows will pile up" : "";
        return (
          <div
            style={{ fontSize: 10, color: tone }}
            title={`connections × msgs/sec × duration = total messages this run will ingest into the cluster. fan-out broadcast deliveries will be ~19× this.`}
          >
            est. ~{est.toLocaleString()} msgs ingested{note}
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={run} disabled={running}>[ run ]</button>
        <button onClick={stop} disabled={!running}>[ stop ]</button>
        <button onClick={reset}>[ reset db ]</button>
      </div>
      <div style={{ color: "#666", fontSize: 11, minHeight: 14 }}>{status}</div>
      {sim && (
        <div
          style={{
            fontSize: 11,
            color: "#888",
            display: "grid",
            gap: 2,
            borderTop: "1px dotted #333",
            paddingTop: 6,
          }}
        >
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="cumulative messages this sim has SENT to the server (resets on each new run)"
          >
            <span>sent</span>
            <span style={{ color: "#c0c0c0" }}>{sim.counters.sent.toLocaleString()}</span>
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="cumulative WS frames RECEIVED across all sim clients combined. each chat msg fans out to ~N subscribers per group, so this is roughly sent × subscribers-per-group + acks"
          >
            <span>received</span>
            <span style={{ color: "#c0c0c0" }}>{sim.counters.received.toLocaleString()}</span>
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="messages per second the sim is producing right now (sum across all clients)"
          >
            <span>sent/s</span>
            <span style={{ color: "#c0c0c0" }}>
              {sim.rates.sent?.toFixed(0) ?? "-"}
            </span>
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="WS frames per second the server is delivering to all sim clients (mostly group broadcasts)"
          >
            <span>recv/s</span>
            <span style={{ color: "#c0c0c0" }}>
              {sim.rates.received?.toFixed(0) ?? "-"}
            </span>
          </div>
          {liveFanout != null && (
            <div
              style={{ display: "flex", justifyContent: "space-between" }}
              title="recv/s ÷ sent/s. how many subscribers each message reaches on average. ~clients-per-group + 1"
            >
              <span>fan-out</span>
              <span style={{ color: "#c0c0c0" }}>{liveFanout.toFixed(2)}×</span>
            </div>
          )}
          {perClientRate != null && (
            <div
              style={{ display: "flex", justifyContent: "space-between" }}
              title="sent/s ÷ live connection count. should track your configured msgs/sec each"
            >
              <span>per-client/s</span>
              <span style={{ color: "#c0c0c0" }}>{perClientRate.toFixed(1)}</span>
            </div>
          )}
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="live WS connections to the server right now"
          >
            <span>connected</span>
            <span style={{ color: "#c0c0c0" }}>
              {sim.counters.connected - sim.counters.disconnected}
            </span>
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between" }}
            title="failed sends since last reset (network errors, channel rejects, etc.)"
          >
            <span>errors</span>
            <span style={{ color: sim.counters.send_errors > 0 ? "#c9a76a" : "#c0c0c0" }}>
              {sim.counters.send_errors}
            </span>
          </div>
        </div>
      )}
      {lastRun && !running && (
        <div
          style={{
            fontSize: 11,
            color: "#888",
            display: "grid",
            gap: 2,
            borderTop: "1px solid #333",
            paddingTop: 6,
          }}
          title="totals + peaks captured when the previous run finished. cleared when you start a new one."
        >
          <div style={{ color: "#888", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
            last run · {lastRun.config.connections}c × {lastRun.config.mps}/s × {lastRun.config.duration}s
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} title="total messages successfully sent during the run">
            <span>total sent</span>
            <span style={{ color: "#c0c0c0" }}>{lastRun.totalSent.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} title="total WS frames received across all sim clients during the run">
            <span>total received</span>
            <span style={{ color: "#c0c0c0" }}>{lastRun.totalRecv.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} title="highest msg/s the sim hit during the run">
            <span>peak sent/s</span>
            <span style={{ color: "#c0c0c0" }}>{lastRun.peakSent.toFixed(0)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} title="highest recv/s — the server's max outbound delivery rate during the run">
            <span>peak recv/s</span>
            <span style={{ color: "#c0c0c0" }}>{lastRun.peakRecv.toFixed(0)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} title="average broadcast amplification: total received ÷ total sent">
            <span>fan-out</span>
            <span style={{ color: "#c0c0c0" }}>{lastRun.fanout.toFixed(2)}×</span>
          </div>
          {lastRun.errors > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>errors</span>
              <span style={{ color: "#c9a76a" }}>{lastRun.errors}</span>
            </div>
          )}
        </div>
      )}
      {presets && (
        <div style={{ fontSize: 10, color: "#555" }}>groups: {presets.groups.join(" ")}</div>
      )}
    </div>
  );
}
