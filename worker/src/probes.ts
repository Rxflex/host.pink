// Проверки из разных точек мира: Globalping (jsDelivr) — тысячи проб, включая домашних провайдеров РФ.
// Если Globalping недоступен или кончился лимит — фоллбек на одну проверку с эджа Cloudflare.
import { answers, doh, isCloudflare, isSpecial, tcpProbe } from "./net";
import { errText, sleep } from "./util";

const API = "https://api.globalping.io/v1/measurements";
const UA = "host.pink/1.0 (+https://host.pink/tools/)";

export const CHECK_TYPES = { http: "HTTP", ping: "Ping", tcp: "TCP", dns: "DNS", mtr: "MTR" } as const;
export type CheckType = keyof typeof CHECK_TYPES;
export type State = "up" | "slow" | "down" | "none";
export type ProbeRow = { cc: string; city: string; network: string; home: boolean; state: State; text: string; raw?: string };

export type Where = { magic: string; limit: number }[];

// Где мерить. Бесплатно — 250 проб в час с IP (500 с токеном), поэтому проб немного, но с толком.
export const WHERE_WIDE: Where = [
  { magic: "RU+eyeball-network", limit: 4 },
  { magic: "RU+datacenter-network", limit: 2 },
  { magic: "KZ", limit: 1 },
  { magic: "DE", limit: 1 },
  { magic: "NL", limit: 1 },
  { magic: "FI", limit: 1 },
  { magic: "US", limit: 1 },
  { magic: "SG", limit: 1 },
];
export const WHERE_RU: Where = [
  { magic: "RU+eyeball-network", limit: 3 },
  { magic: "RU+datacenter-network", limit: 1 },
  { magic: "DE", limit: 1 },
];
const WHERE_MTR: Where = [
  { magic: "RU+eyeball-network", limit: 1 },
  { magic: "DE", limit: 1 },
  { magic: "US", limit: 1 },
];

function headers(env: Env) {
  const h: Record<string, string> = { "user-agent": UA, "content-type": "application/json", "accept-encoding": "br, gzip" };
  const token = (env as any).GLOBALPING_TOKEN as string | undefined;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function body(type: CheckType, target: string, port: number | undefined, where: Where) {
  const base = { target, locations: type === "mtr" ? WHERE_MTR : where };
  switch (type) {
    case "http":
      return { ...base, type: "http", measurementOptions: { protocol: port === 80 ? "HTTP" : "HTTPS", ...(port && port !== 80 && port !== 443 ? { port } : {}), request: { method: "GET", path: "/" } } };
    case "ping":
      return { ...base, type: "ping", measurementOptions: { packets: 3 } };
    case "tcp":
      return { ...base, type: "ping", measurementOptions: { packets: 3, protocol: "TCP", port: port ?? 443 } };
    case "dns":
      return { ...base, type: "dns", measurementOptions: { query: { type: "A" } } };
    case "mtr":
      return { ...base, type: "mtr", measurementOptions: { packets: 3 } };
  }
}

export class ProbeError extends Error {
  constructor(msg: string, public status: number) {
    super(msg);
  }
}

export async function start(env: Env, type: CheckType, target: string, port?: number, where: Where = WHERE_WIDE): Promise<string> {
  const r = await fetch(API, { method: "POST", headers: headers(env), body: JSON.stringify(body(type, target, port, where)), signal: AbortSignal.timeout(6000) });
  if (r.status === 202) return ((await r.json()) as { id: string }).id;
  const j = (await r.json().catch(() => null)) as any;
  const msg = j?.error?.message ?? `HTTP ${r.status}`;
  throw new ProbeError(r.status === 429 ? `лимит Globalping исчерпан (${msg})` : `Globalping: ${msg}`, r.status);
}

export async function fetchResult(env: Env, id: string) {
  const r = await fetch(`${API}/${id}`, { headers: headers(env), signal: AbortSignal.timeout(6000) });
  if (r.status === 404) throw new ProbeError("измерение не найдено или устарело (живут 7 дней)", 404);
  if (!r.ok) throw new ProbeError(`Globalping: HTTP ${r.status}`, r.status);
  const d = (await r.json()) as any;
  return { done: d.status !== "in-progress", type: d.type as string, target: d.target as string, rows: (d.results ?? []).map(toRow) as ProbeRow[] };
}

export async function runAndWait(env: Env, type: CheckType, target: string, port?: number, where?: Where, maxMs = 12000) {
  const id = await start(env, type, target, port, where);
  const t0 = Date.now();
  await sleep(1200);
  let res = await fetchResult(env, id);
  while (!res.done && Date.now() - t0 < maxMs) {
    await sleep(1000);
    res = await fetchResult(env, id);
  }
  return { id, ...res };
}

const ms = (n?: number) => (n == null ? "?" : `${Math.round(n)} мс`);

function toRow(x: any): ProbeRow {
  const p = x.probe ?? {};
  const r = x.result ?? {};
  const row: ProbeRow = { cc: p.country ?? "??", city: p.city ?? "?", network: p.network ?? "", home: (p.tags ?? []).includes("eyeball-network"), state: "none", text: "" };
  if (r.status === "in-progress") return row;
  if (r.status === "failed" || r.status === "offline") return { ...row, state: "down", text: firstLine(r.rawOutput) || "проба не смогла проверить" };
  if (r.statusCode !== undefined && r.timings && !Array.isArray(r.timings) && "firstByte" in r.timings) {
    const t = r.timings.total;
    return { ...row, state: r.statusCode >= 500 ? "down" : t > 1500 ? "slow" : "up", text: `${r.statusCode} ${r.statusCodeName ?? ""}, ${ms(t)} (TLS ${ms(r.timings.tls)}, TTFB ${ms(r.timings.firstByte)}), ${r.resolvedAddress ?? ""}` };
  }
  if (r.stats) {
    const s = r.stats;
    if (!s.rcv) return { ...row, state: "down", text: `нет ответа, потерь ${s.total}/${s.total}${r.resolvedAddress ? `, ${r.resolvedAddress}` : ""}` };
    return { ...row, state: s.loss > 0 ? "slow" : s.avg > 200 ? "slow" : "up", text: `${ms(s.avg)} (мин ${ms(s.min)}), потерь ${s.drop}/${s.total}, ${r.resolvedAddress ?? ""}` };
  }
  if (Array.isArray(r.answers)) {
    const a = r.answers.filter((q: any) => q.type === "A" || q.type === "AAAA").map((q: any) => q.value);
    return { ...row, state: a.length ? "up" : "down", text: a.length ? `${a.join(", ")} (${r.statusCodeName}, ${ms(r.timings?.total)})` : `${r.statusCodeName ?? "пусто"}` };
  }
  if (Array.isArray(r.hops)) {
    const last = r.hops[r.hops.length - 1];
    const ok = !!last?.resolvedAddress && last?.stats?.rcv > 0;
    return { ...row, state: ok ? "up" : "slow", text: `${r.hops.length} хопов${ok ? `, до цели ${ms(last.stats.avg)}` : ", цель не ответила"}`, raw: r.rawOutput };
  }
  return { ...row, state: "none", text: firstLine(r.rawOutput) };
}

const firstLine = (s?: string) => (s ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";

// ---------- фоллбек: одна точка — эдж Cloudflare, где выполняется Worker ----------
export async function edgeCheck(req: Request, type: CheckType, host: string, port?: number): Promise<ProbeRow> {
  const colo = ((req.cf?.colo as string) ?? /^[A-Z]{3}$/.exec(req.headers.get("x-hp-colo") ?? "")?.[0] ?? "?");
  const row: ProbeRow = { cc: (req.cf?.country as string) ?? "??", city: `Cloudflare ${colo}`, network: "эдж Cloudflare", home: false, state: "none", text: "" };
  try {
    if (type === "dns") {
      const r = await doh(host, "A", 0);
      const a = answers(r, "A");
      return { ...row, state: a.length ? "up" : "down", text: a.join(", ") || "пусто" };
    }
    if (type === "http") {
      const t0 = Date.now();
      const r = await fetch(`${port === 80 ? "http" : "https"}://${host}${port && port !== 80 && port !== 443 ? `:${port}` : ""}/`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      r.body?.cancel().catch(() => {});
      const t = Date.now() - t0;
      return { ...row, state: r.status >= 500 ? "down" : t > 1500 ? "slow" : "up", text: `${r.status} ${r.statusText}, ${t} мс` };
    }
    // ping, tcp, mtr: ICMP в Workers нет, меряем TCP-рукопожатие
    let ip = host;
    if (!/^[\d.]+$|:/.test(host)) ip = answers(await doh(host, "A"), "A")[0] ?? "";
    if (!ip) return { ...row, state: "down", text: "имя не резолвится" };
    if (isSpecial(ip) || isCloudflare(ip)) return { ...row, state: "none", text: "адрес Cloudflare или частный: с эджа не проверить" };
    const p = await tcpProbe(ip, port ?? 443, 3000);
    return { ...row, state: p.ms == null ? "down" : p.ms > 200 ? "slow" : "up", text: p.ms != null ? `TCP :${port ?? 443} за ${p.ms} мс` : `TCP :${port ?? 443}: ${p.err}` };
  } catch (e) {
    return { ...row, state: "down", text: errText(e) };
  }
}

export const manualLinks = (host: string) => [
  ["ping.pe", `https://ping.pe/${encodeURIComponent(host)}`],
  ["Globalping", `https://globalping.io/?measurement=&target=${encodeURIComponent(host)}`],
];
