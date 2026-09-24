export const h = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type Mode = "html" | "text" | "json";

export function modeOf(req: Request, url: URL): Mode {
  if (url.searchParams.has("json") || (req.headers.get("accept") ?? "").startsWith("application/json")) return "json";
  const ua = req.headers.get("user-agent") ?? "";
  if (url.searchParams.has("text") || /^(curl|wget|httpie|xh|fetch|aria2|Go-http-client|python-requests)\b|PowerShell/i.test(ua)) return "text";
  return "html";
}

const UA = "host.pink/1.0 (+https://host.pink/tools/)";

export async function getJson<T = any>(
  url: string,
  opt: { ttl?: number; timeout?: number; headers?: Record<string, string>; allow404?: boolean } = {},
): Promise<T | null> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...opt.headers },
    signal: AbortSignal.timeout(opt.timeout ?? 7000),
    cf: opt.ttl === 0 ? undefined : { cacheTtl: opt.ttl ?? 300, cacheEverything: true },
  });
  if (r.status === 404 && opt.allow404) return null;
  if (!r.ok) throw new Error(`${new URL(url).hostname} ответил HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const ripe = (call: string, params: Record<string, string>, ttl = 600, timeout = 8000) =>
  getJson<any>(`https://stat.ripe.net/data/${call}/data.json?${new URLSearchParams({ ...params, sourceapp: "host-pink" })}`, { ttl, timeout }).then(
    (j) => j?.data,
  );

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, msg = "таймаут"): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(msg)))]);
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ago(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(+d)) return iso;
  return d.toISOString().slice(0, 10).split("-").reverse().join(".");
}

export const num = (n: number) => n.toLocaleString("ru-RU");
