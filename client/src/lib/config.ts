// Runtime config — read from Vite env or fall back to localhost defaults.
// On Railway, set VITE_SERVER_URL and VITE_SIM_URL at build time.
const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};

export const SERVER_URL = env.VITE_SERVER_URL ?? "http://localhost:4000";
export const SIM_URL = env.VITE_SIM_URL ?? "http://localhost:4100";
export const SOCKET_URL =
  env.VITE_SOCKET_URL ?? SERVER_URL.replace(/^http/, "ws") + "/socket";
