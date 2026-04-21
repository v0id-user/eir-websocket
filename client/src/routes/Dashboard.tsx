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
    <div style={{ padding: 20, maxWidth: 1400, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 16px 0" }}>live dashboard</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <Stat label="msgs/sec in" value={fmt(live?.rates?.ingest_received)} color="#4ade80" />
        <Stat label="msgs/sec persisted" value={fmt(live?.rates?.batch_persisted)} color="#60a5fa" />
        <Stat label="queue depth" value={live?.pipeline?.queue_depth ?? "—"} />
        <Stat label="ws connections" value={live?.connections ?? "—"} />
        <Stat label="total cached" value={live?.cache?.total ?? "—"} />
        <Stat label="processes" value={live?.system?.processes ?? "—"} />
        <Stat label="memory (MB)" value={live?.system?.memory_mb ?? "—"} />
        <Stat label="run queue" value={live?.system?.run_queue ?? "—"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Panel title="throughput (60s)">
          <Chart
            history={history}
            series={[
              { key: "ingest_received", label: "in", color: "#4ade80" },
              { key: "batch_persisted", label: "persisted", color: "#60a5fa" },
            ]}
          />
        </Panel>
        <Panel title="cluster">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(live?.cluster ?? []).map((n) => (
              <div key={n} style={{ fontSize: 13 }}>
                <span style={{ color: "#4ade80" }}>●</span> {n}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "#888" }}>
            schedulers online: {live?.system?.schedulers ?? "—"}
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

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        padding: 12,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 24, color: color ?? "#eee", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        padding: 16,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#888",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function fmt(n: number | undefined): string {
  if (n == null) return "—";
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
    return <div style={{ color: "#666", fontSize: 13 }}>gathering data…</div>;
  }
  const max = Math.max(
    1,
    ...history.flatMap((s) => series.map((x) => s.rates?.[x.key] ?? 0)),
  );
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
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
            strokeWidth={1.5}
            points={pts.join(" ")}
          />
        );
      })}
      {series.map((s, i) => (
        <text
          key={s.key}
          x={10}
          y={16 + i * 14}
          fill={s.color}
          fontSize={11}
          style={{ fontFamily: "monospace" }}
        >
          ● {s.label}
        </text>
      ))}
      <text x={w - 10} y={14} textAnchor="end" fill="#666" fontSize={10}>
        max {max.toFixed(0)}/s
      </text>
    </svg>
  );
}

function BarList({ entries }: { entries: [string, number][] }) {
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => (
        <div key={k} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 80, color: "#aaa" }}>{k}</span>
          <div
            style={{
              flex: 1,
              height: 10,
              background: "#222",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(v / total) * 100}%`,
                height: "100%",
                background: "#4ade80",
              }}
            />
          </div>
          <span style={{ width: 50, textAlign: "right", color: "#eee" }}>{v}</span>
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

  const { data: presets } = useQuery({ queryKey: ["presets"], queryFn: api.presets });

  async function run() {
    setStatus("starting…");
    try {
      const r = await api.sim.run({ target, connections, msgs_per_sec: mps, duration });
      setStatus(r.ok ? "running" : `error: ${r.error}`);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    }
  }

  async function stop() {
    await api.sim.stop();
    setStatus("stopped");
  }

  async function reset() {
    await api.reset();
    setStatus("db + cache reset");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
      <div>
        target: <span style={{ color: "#60a5fa" }}>{target}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center" }}>
        <label style={{ color: "#888" }}>connections</label>
        <input
          type="number"
          value={connections}
          onChange={(e) => setConnections(+e.target.value)}
          style={inputStyle}
        />
        <label style={{ color: "#888" }}>msgs/sec each</label>
        <input
          type="number"
          value={mps}
          onChange={(e) => setMps(+e.target.value)}
          style={inputStyle}
        />
        <label style={{ color: "#888" }}>duration (s)</label>
        <input
          type="number"
          value={duration}
          onChange={(e) => setDuration(+e.target.value)}
          style={inputStyle}
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={run} disabled={running} style={btnStyle}>
          ▶ run
        </button>
        <button onClick={stop} disabled={!running} style={btnStyle}>
          ■ stop
        </button>
        <button onClick={reset} style={{ ...btnStyle, borderColor: "#553" }}>
          ⟲ reset db
        </button>
      </div>
      <div style={{ color: "#888", fontSize: 11 }}>{status}</div>
      {sim && (
        <div style={{ fontSize: 11, color: "#888", display: "grid", gap: 2 }}>
          <span>sent: {sim.counters.sent} · received: {sim.counters.received}</span>
          <span>sent/s: {sim.rates.sent?.toFixed(0) ?? "—"} · recv/s: {sim.rates.received?.toFixed(0) ?? "—"}</span>
          <span>connected: {sim.counters.connected - sim.counters.disconnected} · errors: {sim.counters.send_errors}</span>
        </div>
      )}
      {presets && (
        <div style={{ fontSize: 11, color: "#666" }}>
          groups: {presets.groups.join(", ")}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0a0a0a",
  color: "#eee",
  border: "1px solid #333",
  padding: "4px 8px",
  borderRadius: 4,
  fontFamily: "inherit",
};

const btnStyle: React.CSSProperties = {
  background: "#0a0a0a",
  color: "#eee",
  border: "1px solid #333",
  padding: "6px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
};
