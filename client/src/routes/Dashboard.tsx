import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Snapshot, type SimSnapshot } from "../lib/api";
import { joinMetrics } from "../lib/socket";
import { getNickname } from "../lib/nickname";
import { SOCKET_URL } from "../lib/config";

export function Dashboard() {
  const [live, setLive] = useState<Snapshot | null>(null);
  const [sim, setSim] = useState<SimSnapshot | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);

  useEffect(() => {
    const ch = joinMetrics(getNickname());
    ch.on("snapshot", (payload: Snapshot) => setLive(payload));
    ch.on("tick", (payload: Snapshot) => {
      setLive(payload);
      setHistory((h) => [...h.slice(-59), payload]);
    });
    ch.join();
    return () => {
      ch.leave();
    };
  }, []);

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
    <div style={{ padding: 12, maxWidth: 1400, margin: "0 auto" }}>
      <div
        style={{
          fontSize: 11,
          color: "#888",
          padding: "4px 8px",
          borderBottom: "1px solid #333",
          marginBottom: 12,
        }}
      >
        /dashboard
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 1,
          marginBottom: 12,
          border: "1px solid #333",
          background: "#333",
        }}
      >
        <Stat label="msgs/sec in" value={fmt(live?.rates?.ingest_received)} />
        <Stat label="msgs/sec persisted" value={fmt(live?.rates?.batch_persisted)} />
        <Stat label="queue depth" value={live?.pipeline?.queue_depth ?? "-"} />
        <Stat label="ws connections" value={live?.connections ?? "-"} />
        <Stat label="total cached" value={live?.cache?.total ?? "-"} />
        <Stat label="processes" value={live?.system?.processes ?? "-"} />
        <Stat label="memory (MB)" value={live?.system?.memory_mb ?? "-"} />
        <Stat label="run queue" value={live?.system?.run_queue ?? "-"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Panel title="throughput [60s]">
          <Chart
            history={history}
            series={[
              { key: "ingest_received", label: "in", color: "#c0c0c0" },
              { key: "batch_persisted", label: "persisted", color: "#707070" },
            ]}
          />
        </Panel>
        <Panel title="cluster">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {(live?.cluster ?? []).map((n) => (
              <div key={n} style={{ fontSize: 12 }}>
                <span style={{ color: "#888" }}>[*]</span> {n}
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              fontSize: 11,
              color: "#666",
              borderTop: "1px dotted #333",
              paddingTop: 6,
            }}
          >
            schedulers online: {live?.system?.schedulers ?? "-"}
          </div>
        </Panel>
        <Panel title="cache by group">
          <BarList entries={Object.entries(live?.cache?.groups ?? {})} />
        </Panel>
        <Panel title="simulator">
          <SimControls sim={sim} />
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ background: "#0a0a0a", padding: "8px 12px" }}>
      <div
        style={{
          fontSize: 10,
          color: "#666",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, color: "#e0e0e0", marginTop: 4, fontWeight: "normal" }}>
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
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
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function fmt(n: number | undefined): string {
  if (n == null) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function Chart({
  history,
  series,
}: {
  history: Snapshot[];
  series: { key: string; label: string; color: string }[];
}) {
  const w = 600;
  const h = 140;
  if (history.length < 2) {
    return <div style={{ color: "#555", fontSize: 12 }}>... gathering data</div>;
  }
  const max = Math.max(
    1,
    ...history.flatMap((s) => series.map((x) => s.rates?.[x.key] ?? 0)),
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
          const v = snap.rates?.[s.key] ?? 0;
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
            style={{
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
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

function SimControls({ sim }: { sim: SimSnapshot | null }) {
  const [connections, setConnections] = useState(100);
  const [mps, setMps] = useState(10);
  const [duration, setDuration] = useState(30);
  const [status, setStatus] = useState<string>("");

  const target = SOCKET_URL + "/websocket";
  const running = sim?.run != null;

  const { data: presets } = useQuery({
    queryKey: ["presets"],
    queryFn: api.presets,
  });

  async function run() {
    setStatus("> starting...");
    try {
      const r = await api.sim.run({
        target,
        connections,
        msgs_per_sec: mps,
        duration,
      });
      setStatus(r.ok ? "> running" : `> error: ${r.error}`);
    } catch (e) {
      setStatus(`> error: ${(e as Error).message}`);
    }
  }

  async function stop() {
    await api.sim.stop();
    setStatus("> stopped");
  }

  async function reset() {
    await api.reset();
    setStatus("> db + cache reset");
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}
    >
      <div style={{ color: "#888" }}>
        target:{" "}
        <span style={{ color: "#c0c0c0", wordBreak: "break-all" }}>
          {target}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 6,
          alignItems: "center",
        }}
      >
        <label style={{ color: "#888" }}>connections</label>
        <input
          type="number"
          value={connections}
          onChange={(e) => setConnections(+e.target.value)}
        />
        <label style={{ color: "#888" }}>msgs/sec each</label>
        <input
          type="number"
          value={mps}
          onChange={(e) => setMps(+e.target.value)}
        />
        <label style={{ color: "#888" }}>duration (s)</label>
        <input
          type="number"
          value={duration}
          onChange={(e) => setDuration(+e.target.value)}
        />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={run} disabled={running}>
          [ run ]
        </button>
        <button onClick={stop} disabled={!running}>
          [ stop ]
        </button>
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
          <span>
            sent: {sim.counters.sent} . received: {sim.counters.received}
          </span>
          <span>
            sent/s: {sim.rates.sent?.toFixed(0) ?? "-"} . recv/s:{" "}
            {sim.rates.received?.toFixed(0) ?? "-"}
          </span>
          <span>
            connected: {sim.counters.connected - sim.counters.disconnected} .
            errors: {sim.counters.send_errors}
          </span>
        </div>
      )}
      {presets && (
        <div style={{ fontSize: 10, color: "#555" }}>
          groups: {presets.groups.join(" ")}
        </div>
      )}
    </div>
  );
}
