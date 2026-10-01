export interface Session { token: string; role: "admin" | "dispatcher"; user: string }

export async function api<T = any>(path: string, s: Session | null, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  return r.json();
}

export const hhmm = (ts: number | null | undefined) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
