import { SERVER_URL, SIM_URL } from "./config";

export type Message = {
  id: string;
  group_id: string;
  author: string;
  body: string;
  reply_to_id: string | null;
  node: string;
  inserted_at: string;
};

export type Snapshot = {
  node: string;
  cluster: string[];
  at_ms: number;
  counters: Record<string, number>;
  rates: Record<string, number>;
  cache: { total: number; groups: Record<string, number> };
  pipeline: { queue_depth: number };
  system: {
    processes: number;
    processes_limit: number;
    ports: number;
    ports_limit: number;
    atoms: number;
    atoms_limit: number;
    ets_tables: number;
    memory_mb: number;
    memory_processes_mb: number;
    memory_binary_mb: number;
    memory_ets_mb: number;
    memory_code_mb: number;
    schedulers: number;
    run_queue: number;
    reductions_total: number;
    io_in_mb: number;
    io_out_mb: number;
    uptime_s: number;
  };
  connections: number;
};

export type SimSnapshot = {
  counters: Record<string, number>;
  rates: Record<string, number>;
  run: null | {
    id: number;
    target: string;
    connections: number;
    msgs_per_sec: number;
    duration: number;
    groups: string[];
    started_ms: number;
    end_ms: number;
  };
  node: string;
  at_ms: number;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const api = {
  presets: () =>
    fetch(`${SERVER_URL}/api/presets`).then(json<{ groups: string[]; authors: string[] }>),
  stats: () => fetch(`${SERVER_URL}/api/stats`).then(json<Snapshot>),
  reset: () =>
    fetch(`${SERVER_URL}/api/reset`, { method: "POST" }).then(json<{ ok: boolean }>),
  history: (groupId: string, before?: string, limit = 50) => {
    const u = new URL(`${SERVER_URL}/api/groups/${groupId}/messages`);
    if (before) u.searchParams.set("before", before);
    u.searchParams.set("limit", String(limit));
    return fetch(u.toString()).then(
      json<{ source: string; messages: Message[] }>,
    );
  },
  sim: {
    stats: () => fetch(`${SIM_URL}/stats`).then(json<SimSnapshot>),
    run: (params: {
      target: string;
      connections: number;
      msgs_per_sec: number;
      duration: number;
      body_size?: number;
    }) =>
      fetch(`${SIM_URL}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      }).then(json<{ ok: boolean; run?: SimSnapshot["run"]; error?: string }>),
    stop: () =>
      fetch(`${SIM_URL}/stop`, { method: "POST" }).then(json<{ ok: boolean }>),
  },
};
