// IP-арифметика, спецдиапазоны, классификация ввода, DoH и TCP-пинг
import { connect } from "cloudflare:sockets";
import { getJson, withTimeout } from "./util";

export function v4(s: string): number | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

export function v6(s: string): bigint | null {
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  let host: string;
  try {
    host = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [a, b] = host.split("::");
  const head = a ? a.split(":") : [];
  const tail = b !== undefined ? (b ? b.split(":") : []) : [];
  if (tail.length && tail[tail.length - 1].includes(".")) {
    const n = v4(tail.pop()!)!;
    tail.push((n >>> 16).toString(16), (n & 0xffff).toString(16));
  }
  const fill = b !== undefined ? Array(8 - head.length - tail.length).fill("0") : [];
  const parts = [...head, ...fill, ...tail];
  if (parts.length !== 8) return null;
  return parts.reduce((acc, p) => (acc << 16n) | BigInt(parseInt(p || "0", 16)), 0n);
}

export const normV6 = (s: string) => new URL(`http://[${s}]/`).hostname.slice(1, -1);

function in4(ip: number, cidr: string) {
  const [base, len] = cidr.split("/");
  const mask = Number(len) === 0 ? 0 : (~0 << (32 - Number(len))) >>> 0;
  return (ip & mask) >>> 0 === (v4(base)! & mask) >>> 0;
}
function in6(ip: bigint, cidr: string) {
  const [base, len] = cidr.split("/");
  const shift = 128n - BigInt(len);
  return ip >> shift === v6(base)! >> shift;
}

const SPECIAL4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
const SPECIAL6 = ["::/127", "::ffff:0:0/96", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8"];
// https://www.cloudflare.com/ips/ + анонимные резолверы: сюда сокеты из Workers не ходят
const CF4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "1.1.1.0/24", "1.0.0.0/24"];
const CF6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

export function isSpecial(ip: string) {
  const a = v4(ip);
  if (a !== null) return SPECIAL4.some((c) => in4(a, c));
  const b = v6(ip);
  return b !== null && SPECIAL6.some((c) => in6(b, c));
}
export function isCloudflare(ip: string) {
  const a = v4(ip);
  if (a !== null) return CF4.some((c) => in4(a, c));
  const b = v6(ip);
  return b !== null && CF6.some((c) => in6(b, c));
}

export function ptrName(ip: string): string | null {
  const a = v4(ip);
  if (a !== null) return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  const b = v6(ip);
  if (b === null) return null;
  return b.toString(16).padStart(32, "0").split("").reverse().join(".") + ".ip6.arpa";
}

export type Kind =
  | { t: "ip"; ip: string; v: 4 | 6 }
  | { t: "prefix"; p: string }
  | { t: "asn"; n: number }
  | { t: "host"; host: string }
  | { t: "ask"; q: string }
  | { t: "search"; q: string };

// хвосты, которые почти всегда файлы, а не TLD: боты долбят /wp-login.php, /favicon.ico
const FILE_EXT = /\.(php|ico|png|jpe?g|gif|webp|svg|css|js|map|json|xml|txt|html?|env|git|bak|sql|zip|gz|tar|asp|aspx|jsp|cgi|yml|yaml|ini|log|well-known)$/;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function classify(raw: string, allowText = true): Kind | null {
  let s = raw.trim();
  if (!s) return null;
  const asn = s.match(/^as\s*(\d{1,10})$/i) ?? (/^\d{1,10}$/.test(s) ? [s, s] : null);
  if (asn && Number(asn[1]) <= 4294967295) return { t: "asn", n: Number(asn[1]) };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname.replace(/^\[|\]$/g, "");
    } catch {}
  }
  const pre = s.match(/^([0-9a-f:.]+)\/(\d{1,3})$/i);
  if (pre) {
    const len = Number(pre[2]);
    if (v4(pre[1]) !== null && len <= 32) return { t: "prefix", p: `${pre[1]}/${len}` };
    if (v6(pre[1]) !== null && len <= 128) return { t: "prefix", p: `${normV6(pre[1])}/${len}` };
  }
  const bare = s.replace(/^\[|\]$/g, "");
  if (v4(bare) !== null) return { t: "ip", ip: bare, v: 4 };
  if (v6(bare) !== null) return { t: "ip", ip: normV6(bare), v: 6 };

  if (!/\s/.test(s)) {
    const cand = s.split("/")[0].replace(/:\d+$/, "").replace(/\.$/, "");
    try {
      const host = new URL(`http://${cand}/`).hostname;
      if (DOMAIN.test(host) && !FILE_EXT.test(host)) return { t: "host", host };
    } catch {}
  }
  if (!allowText) return null;
  const words = s.split(/\s+/).length;
  return /\?$/.test(s) || words >= 3 ? { t: "ask", q: s } : { t: "search", q: s };
}

export function hrefOf(k: Kind): string {
  switch (k.t) {
    case "ip": return `/${k.ip}`;
    case "prefix": return `/${k.p}`;
    case "asn": return `/AS${k.n}`;
    case "host": return `/${k.host}`;
    case "ask": return `/ask?q=${encodeURIComponent(k.q)}`;
    case "search": return `/search?q=${encodeURIComponent(k.q)}`;
  }
}

// ---------- DNS over HTTPS ----------
export type DohAnswer = { name: string; type: number; TTL: number; data: string };
export type Doh = { Status: number; AD?: boolean; Answer?: DohAnswer[]; Authority?: DohAnswer[] };

export const RR: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DS: 43, DNSKEY: 48, HTTPS: 65, CAA: 257 };
export const RR_NAME = Object.fromEntries(Object.entries(RR).map(([k, v]) => [v, k]));
export const RCODE: Record<number, string> = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED" };

export function doh(name: string, type: string, ttl = 60) {
  return getJson<Doh>(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}&do=1`, {
    headers: { accept: "application/dns-json" },
    ttl,
    timeout: 4000,
  }) as Promise<Doh>;
}

export const answers = (r: Doh | null, type: string) => (r?.Answer ?? []).filter((a) => a.type === RR[type]).map((a) => a.data);

// ---------- TCP-пинг ----------
export type Probe = { ms: number | null; err?: string };

export async function tcpProbe(ip: string, port: number, timeout = 2500): Promise<Probe> {
  const t0 = Date.now();
  const sock = connect({ hostname: ip, port });
  try {
    await withTimeout(sock.opened, timeout, "таймаут");
    return { ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ms: null, err: /timeout|таймаут/i.test(msg) ? "таймаут" : /refused|reset/i.test(msg) ? "порт закрыт" : /cannot connect|prohibited|not allowed/i.test(msg) ? "запрещено платформой" : msg.slice(0, 80) };
  } finally {
    sock.close().catch(() => {});
  }
}

export const PING_PORTS = new Set([21, 22, 53, 80, 110, 143, 443, 465, 587, 853, 993, 995, 1194, 1723, 2053, 2083, 2087, 2096, 3306, 3389, 5222, 5432, 6379, 8000, 8080, 8443, 8880, 9000, 9443, 10000, 27017, 51820]);
