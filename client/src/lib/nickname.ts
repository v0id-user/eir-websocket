const KEY = "eir.nickname";

const DEFAULTS = [
  "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
  "ivan", "judy",
];

export function getNickname(): string {
  const saved = localStorage.getItem(KEY);
  if (saved) return saved;
  const pick = DEFAULTS[Math.floor(Math.random() * DEFAULTS.length)];
  localStorage.setItem(KEY, pick);
  return pick;
}

export function setNickname(n: string): void {
  localStorage.setItem(KEY, n);
}
