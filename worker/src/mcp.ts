// MCP-сервер host.pink: Streamable HTTP, без сессий и без SSE — укладывается в бесплатный Worker.
// Понимает и новую stateless-схему (2026-07-28: server/discover, версия в каждом запросе),
// и классическую (initialize, 2025-03-26 … 2025-11-25). Тулзы вызывают те же обработчики, что и сайт, в JSON-режиме.
import { adContact } from "./ads";
import { json } from "./shell";

const LATEST = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED = [LATEST, ...LEGACY];
const SERVER_INFO = { name: "host.pink", title: "host.pink — network tools & sysadmin knowledge base", version: "1.0.0", websiteUrl: "https://host.pink/mcp" };

const INSTRUCTIONS = `host.pink: network diagnostics and a Russian-language knowledge base for people who run servers, VPN nodes and panels (Remnawave, Xray, Bedolaga bot).
Tools return JSON (Russian labels). Use ip_lookup / domain_lookup / asn_lookup / prefix_lookup for dossiers, check_availability to see reachability from Russia (home ISPs and datacenters) and the world, search_knowledge_base + read_page for community knowledge with dated proofs.
Knowledge-base facts about censorship circumvention go stale in 1–3 months: always mention the date of the source.
Limits: 30 network checks per minute per IP, 3 AI questions per minute.`;

type Json = Record<string, unknown>;
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  path: (a: Json) => string;
  raw?: boolean; // ответ — текст, а не JSON
};

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const enc = (v: unknown) => encodeURIComponent(String(v ?? "").trim());

const TOOLS: Tool[] = [
  {
    name: "ip_lookup",
    title: "IP dossier",
    description: "Everything public about an IPv4/IPv6 address: owner ASN and holder, geo, PTR, open ports, CPEs and CVEs (Shodan InternetDB), DNSBL/RIPE blocklists, Tor, TCP reachability from Cloudflare edge, BGP routing and RPKI, whois with abuse contact, upstream map to Tier 1.",
    inputSchema: { type: "object", properties: { ip: str("IPv4 or IPv6 address, e.g. 8.8.8.8") }, required: ["ip"] },
    path: (a) => `/${enc(a.ip)}`,
  },
  {
    name: "domain_lookup",
    title: "Domain dossier",
    description: "Domain health report: DNS (A/AAAA/NS/MX, SPF, DMARC, CAA, DNSSEC), HTTPS response and security headers, whether DDoS protection/CDN is in front, reachability from Russian home ISPs vs abroad (Globalping), server IP owner, TLS certificates and subdomains from Certificate Transparency, registration (RDAP / .ru whois).",
    inputSchema: { type: "object", properties: { domain: str("Domain name, e.g. example.com (no scheme)") }, required: ["domain"] },
    path: (a) => `/${enc(String(a.domain).replace(/^https?:\/\//, "").split("/")[0])}`,
  },
  {
    name: "asn_lookup",
    title: "ASN dossier",
    description: "Autonomous system report: holder, PeeringDB profile, number of announced IPv4/IPv6 prefixes, upstreams and downstreams, internet exchange presence, whois, and the connectivity map (which transits and Tier 1 networks its routes go through, with share of RIPE RIS paths).",
    inputSchema: { type: "object", properties: { asn: { type: ["integer", "string"], description: "AS number, e.g. 13335 or AS13335" } }, required: ["asn"] },
    path: (a) => `/AS${String(a.asn).replace(/^as/i, "")}`,
  },
  {
    name: "prefix_lookup",
    title: "Prefix dossier",
    description: "IP prefix report: who announces it, RPKI validity, visibility across RIPE RIS peers, first seen, covering/more-specific prefixes, subnet arithmetic, whois, upstream map. Private ranges return the subnet calculator instead.",
    inputSchema: { type: "object", properties: { prefix: str("CIDR, e.g. 1.1.1.0/24 or 2606:4700::/32") }, required: ["prefix"] },
    path: (a) => `/${String(a.prefix).trim()}`,
  },
  {
    name: "dns_records",
    title: "DNS records",
    description: "DNS records via DNS-over-HTTPS (1.1.1.1) with TTLs and DNSSEC status. Without type returns A, AAAA, CNAME, NS, MX, TXT, CAA, HTTPS, SOA, DS.",
    inputSchema: {
      type: "object",
      properties: { name: str("Domain name"), type: str("Optional single record type", { enum: ["A", "AAAA", "CNAME", "NS", "MX", "TXT", "CAA", "HTTPS", "SOA", "DS", "SRV", "PTR"] }) },
      required: ["name"],
    },
    path: (a) => `/dns/${enc(a.name)}${a.type ? `?t=${enc(a.type)}` : ""}`,
  },
  {
    name: "tcp_ping",
    title: "TCP ping from Cloudflare edge",
    description: "Measures TCP handshake time (4 attempts) from the Cloudflare datacenter that handles the request. Not ICMP. Cloudflare-owned IPs cannot be tested this way; use check_availability.",
    inputSchema: {
      type: "object",
      properties: { host: str("IP or domain"), port: { type: "integer", description: "TCP port, default 443. Only common service ports are allowed.", default: 443 } },
      required: ["host"],
    },
    path: (a) => `/ping/${enc(a.host)}${a.port ? `?port=${Number(a.port)}` : ""}`,
  },
  {
    name: "check_availability",
    title: "Check from many countries",
    description: "Runs a measurement from ~12 Globalping probes: 4 Russian home ISPs, 2 Russian datacenters, Kazakhstan, Germany, Netherlands, Finland, USA, Singapore. Use it to tell a Russian block (fails only on RU home probes) from a real outage. Types: http, ping (ICMP), tcp (needs port, default 443), dns, mtr (traceroute from 3 probes). Takes up to ~15 s.",
    inputSchema: {
      type: "object",
      properties: {
        target: str("Domain or IP"),
        type: str("Check type", { enum: ["http", "ping", "tcp", "dns", "mtr"], default: "http" }),
        port: { type: "integer", description: "Port for tcp/http checks" },
      },
      required: ["target"],
    },
    path: (a) => `/check/${enc(a.target)}${a.port ? `:${Number(a.port)}` : ""}?t=${enc(a.type ?? "http")}`,
  },
  {
    name: "subnet_calc",
    title: "Subnet calculator",
    description: "IPv4/IPv6 subnet arithmetic: network, mask, wildcard, broadcast, host range, address count, halves and parent prefix. Pure computation, no network calls.",
    inputSchema: { type: "object", properties: { cidr: str("Address with prefix length, e.g. 192.168.1.77/26") }, required: ["cidr"] },
    path: (a) => `/calc/${String(a.cidr).trim()}`,
  },
  {
    name: "search_knowledge_base",
    title: "Search the knowledge base",
    description: "Full-text search over host.pink (Russian): BedolagaBD community knowledge base (Remnawave/Bedolaga panels, Xray transports, bypassing Russian DPI/TSPU, hosting providers, payments, scripts) plus verified sysadmin guides. Returns page URLs with section anchors and snippets. Query in Russian or English technical terms works best.",
    inputSchema: { type: "object", properties: { query: str("Search query, e.g. 'xhttp selfsteal' or 'BBR sysctl'"), limit: { type: "integer", description: "Max results, 1–20, default 10", default: 10 } }, required: ["query"] },
    path: (a) => `/search?q=${enc(a.query)}&limit=${Math.min(20, Math.max(1, Number(a.limit) || 10))}`,
  },
  {
    name: "read_page",
    title: "Read a knowledge base page",
    description: "Returns the full markdown of a host.pink article, e.g. '/baza/transporty/xhttp/' or '/gaidy/mtu-i-tunneli/'. Use paths from search_knowledge_base results or site_map. Anchors are ignored.",
    inputSchema: { type: "object", properties: { path: str("Page path starting with /baza/ or /gaidy/") }, required: ["path"] },
    path: (a) => {
      const p = String(a.path).replace(/^https?:\/\/host\.pink/, "").split("#")[0].split("?")[0];
      return (p.endsWith("/") ? p : `${p}/`) + "index.md";
    },
    raw: true,
  },
  {
    name: "site_map",
    title: "Site map",
    description: "llms.txt of host.pink: every section and article with a one-line summary, plus the HTTP API description. Call first if you need to browse the knowledge base.",
    inputSchema: { type: "object", properties: {} },
    path: () => "/llms.txt",
    raw: true,
  },
  {
    name: "ask_knowledge_base",
    title: "Ask the knowledge base AI",
    description: "Asks the host.pink AI (Workers AI) a question; it answers in Russian using only knowledge base fragments and cites sources. Limited to 3 questions per minute and a daily free quota; prefer search_knowledge_base + read_page when you can reason yourself.",
    inputSchema: { type: "object", properties: { question: str("Question in Russian or English") }, required: ["question"] },
    path: (a) => `/ask?q=${enc(a.question)}`,
    raw: true,
  },
];

const listTools = () =>
  TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));

type Call = (path: string, accept: string) => Promise<Response>;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

const rpc = (id: unknown, result: unknown) => withCors(json({ jsonrpc: "2.0", id, result }));
const rpcError = (id: unknown, code: number, message: string, data?: unknown, status = 200) =>
  withCors(json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, status));

function withCors(r: Response) {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

export async function handleMcp(req: Request, call: Call, humanPage: () => Promise<Response>): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") {
    // браузеру — страница с инструкцией; MCP-клиенту, который хочет SSE-поток, — 405: потоков у нас нет
    if ((req.headers.get("accept") ?? "").includes("text/html")) return humanPage();
    return new Response("host.pink MCP: use POST (Streamable HTTP, JSON responses, no SSE stream).", { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", undefined, 400);
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "Batch requests are not supported", undefined, 400);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request", undefined, 400);

  // уведомления и ответы клиента: принять и молчать
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202, headers: cors });

  const params = msg.params ?? {};
  const version = req.headers.get("mcp-protocol-version") ?? params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? "";
  const modern = version === LATEST;
  if (version && !SUPPORTED.includes(version) && msg.method !== "initialize") {
    return rpcError(msg.id, -32022, `Unsupported protocol version ${version}`, { supported: SUPPORTED, requested: version }, 400);
  }
  const cache = (ttlMs: number) => (modern ? { resultType: "complete", ttlMs, cacheScope: "public" } : {});

  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return rpc(msg.id, {
        protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return rpc(msg.id, {
        resultType: "complete",
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        ttlMs: 3600000,
        cacheScope: "public",
      });
    case "ping":
      return rpc(msg.id, modern ? { resultType: "complete" } : {});
    case "tools/list":
      return rpc(msg.id, { tools: listTools(), ...cache(3600000) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
      const args = (params.arguments ?? {}) as Json;
      const missing = ((tool.inputSchema.required as string[]) ?? []).filter((k) => args[k] === undefined || args[k] === "");
      if (missing.length) return rpc(msg.id, toolResult(modern, `Missing required argument: ${missing.join(", ")}`, undefined, true));
      try {
        const res = await call(tool.path(args), tool.raw ? "text/plain" : "application/json");
        const body = await res.text();
        if (tool.raw) return rpc(msg.id, toolResult(modern, body, undefined, !res.ok));
        let data: unknown;
        try {
          data = compact(JSON.parse(body));
        } catch {
          data = undefined;
        }
        const isErr = !res.ok;
        return rpc(msg.id, toolResult(modern, data ? JSON.stringify(data, null, 1) : body, data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : undefined, isErr));
      } catch (e) {
        return rpc(msg.id, toolResult(modern, `host.pink error: ${e instanceof Error ? e.message : String(e)}`, undefined, true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// Меньше мусора в контексте агента: null-поля, пустые строки и служебные хеши сертификатов не несут смысла
const DROP = new Set(["details_link", "comment", "tbs_sha256", "pubkey_sha256", "cert_sha256", "query_starttime", "query_endtime", "social_media", "logo", "meta"]);
function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) {
      if (DROP.has(k) || x === null || x === "") continue;
      const c = compact(x);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return v;
}

function toolResult(modern: boolean, text: string, structured: Json | undefined, isError: boolean) {
  return {
    ...(modern ? { resultType: "complete" } : {}),
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
    isError,
  };
}

export const MCP_TOOLS = TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description }));
export const MCP_CONTACT = adContact;
