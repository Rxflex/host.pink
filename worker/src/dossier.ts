// Досье: IP, префикс, ASN, домен. Каждая карточка — отдельный источник, приходят по мере готовности.
import { connect } from "cloudflare:sockets";
import { answers, doh, isCloudflare, isSpecial, ptrName, RCODE, tcpProbe, v4 } from "./net";
import { pickSponsor } from "./ansi";
import { graphSection } from "./asgraph";
import { calc } from "./calc";
import { edgeCheck, manualLinks, runAndWait, WHERE_RU } from "./probes";
import { code, ext, link, report, type Result, type Row, type Section } from "./shell";
import { ago, errText, getJson, h, type Mode, num, ripe, withTimeout } from "./util";

// ---------- общие источники ----------

type Owner = { prefix?: string; asns: { asn: number; holder: string }[]; announced: boolean };

const ownerOf = (res: string) =>
  ripe("prefix-overview", { resource: res }).then((d): Owner => ({ prefix: d?.resource, asns: d?.asns ?? [], announced: !!d?.announced }));

const asnLink = (a: { asn: number; holder?: string }) => `${link(`/AS${a.asn}`, `AS${a.asn}`)}${a.holder ? ` ${h(a.holder)}` : ""}`;

async function geo(res: string): Promise<Row[]> {
  const d = await ripe("maxmind-geo-lite", { resource: res }, 86400);
  const loc = d?.located_resources?.[0]?.locations?.[0];
  if (!loc) return [];
  const where = [loc.city, loc.country].filter(Boolean).join(", ");
  return [
    { k: "где", v: where || "неизвестно" },
    ...(loc.latitude != null ? [{ k: "координаты", v: `${loc.latitude}, ${loc.longitude}`, html: ext(`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=9/${loc.latitude}/${loc.longitude}`, `${loc.latitude}, ${loc.longitude}`) }] : []),
  ];
}

function routingSection(owner: Promise<Owner>, res: string): Section {
  return {
    id: "routing",
    title: "Маршрутизация и RPKI",
    run: async () => {
      const o = await owner;
      if (!o.announced || !o.prefix) return { state: "down", note: "не анонсируется", rows: [{ k: "BGP", v: "Префикс не виден в глобальной таблице. Либо адрес не используется, либо его прячут." }] };
      const origin = o.asns[0]?.asn;
      const [st, rpki] = await Promise.all([
        ripe("routing-status", { resource: o.prefix }).catch(() => null),
        origin ? ripe("rpki-validation", { resource: `AS${origin}`, prefix: o.prefix }).catch(() => null) : null,
      ]);
      const vis = st?.visibility?.v4?.total_ris_peers ? st.visibility.v4 : st?.visibility?.v6;
      const rpk = rpki?.status as string | undefined;
      const rows: Row[] = [
        { k: "префикс", v: o.prefix, html: link(`/${o.prefix}`, o.prefix) },
        { k: "origin AS", v: o.asns.map((a) => `AS${a.asn} ${a.holder}`).join(", "), html: o.asns.map(asnLink).join("<br>") },
      ];
      // RIPEstat: valid | invalid_asn | invalid_length | unknown (ROA нет)
      const bad = !!rpk?.startsWith("invalid");
      const rpkText = rpk === "valid" ? "valid, ROA есть" : rpk === "invalid_asn" ? "INVALID: анонсирует не тот AS, что в ROA" : rpk === "invalid_length" ? "INVALID: префикс длиннее, чем разрешает ROA" : bad ? "INVALID: анонс не совпадает с ROA" : "нет ROA";
      if (rpk) rows.push({ k: "RPKI", v: `${rpk} (${rpkText})`, html: `<span class="st st-${rpk === "valid" ? "up" : bad ? "down" : "none"}"></span>${h(rpkText)}` });
      if (vis) rows.push({ k: "видимость", v: `${vis.ris_peers_seeing} из ${vis.total_ris_peers} пиров RIS` });
      if (st?.first_seen?.time) rows.push({ k: "впервые замечен", v: ago(st.first_seen.time) });
      if (st?.less_specifics?.length) rows.push({ k: "покрывающие", v: st.less_specifics.slice(0, 4).map((x: any) => x.prefix).join(", ") });
      if (st?.more_specifics?.length) rows.push({ k: "более узкие", v: `${st.more_specifics.length} шт.` });
      return { state: rpk?.startsWith("invalid") ? "down" : "up", note: "RIPEstat", rows, data: { prefix: o.prefix, origins: o.asns, rpki: rpk, visibility: vis, first_seen: st?.first_seen?.time } };
    },
  };
}

function whoisSection(res: string): Section {
  return {
    id: "whois",
    title: "Whois и регистратор",
    run: async () => {
      const [w, rir, abuse] = await Promise.all([
        ripe("whois", { resource: res }, 3600, 14000),
        ripe("rir", { resource: res, lod: "2" }, 86400).catch(() => null),
        ripe("abuse-contact-finder", { resource: res }, 3600).catch(() => null),
      ]);
      const recs: [string, string][] = (w?.records ?? []).flat().map((x: any) => [x.key, x.value]);
      const pick = (...keys: string[]) => recs.find(([k]) => keys.includes(k.toLowerCase()))?.[1];
      const r = rir?.rirs?.[0];
      const rows: Row[] = [];
      const net = pick("inetnum", "inet6num", "netrange", "cidr");
      if (net) rows.push({ k: "блок", v: net });
      const name = pick("netname", "orgname", "org-name", "descr");
      if (name) rows.push({ k: "сеть", v: name });
      const org = pick("org", "organization", "orgid");
      if (org) rows.push({ k: "организация", v: org });
      const cc = pick("country");
      if (cc) rows.push({ k: "страна в whois", v: cc.toUpperCase() });
      if (r) rows.push({ k: "RIR", v: r.rir });
      const ab = abuse?.abuse_contacts ?? [];
      rows.push({ k: "abuse", v: ab.join(", ") || "не указан", html: ab.length ? ab.map((m: string) => `<a href="mailto:${h(m)}">${h(m)}</a>`).join(", ") : "не указан. Классика." });
      const raw = (w?.records ?? []).map((blk: any[]) => blk.map((x) => `${x.key.padEnd(16)} ${x.value}`).join("\n")).join("\n\n");
      return {
        state: "up",
        note: "RIPEstat",
        rows,
        html: raw ? `<details><summary>Сырой whois</summary><pre>${h(raw.slice(0, 12000))}</pre></details>` : "",
        data: { rir: r?.rir, abuse: ab, records: w?.records },
      };
    },
  };
}

// ---------- IP ----------

function bgpToolsWhois(ip: string): Promise<string | null> {
  return withTimeout(
    (async () => {
      const sock = connect({ hostname: "bgp.tools", port: 43 });
      const wr = sock.writable.getWriter();
      await wr.write(new TextEncoder().encode(` -v ${ip}\r\n`));
      const out = await new Response(sock.readable).text();
      sock.close().catch(() => {});
      return out.trim().split("\n").pop() ?? null;
    })(),
    3500,
  ).catch(() => null);
}

const DNSBL = ["bl.spamcop.net", "psbl.surriel.com", "dnsbl-1.uceprotect.net", "all.s5h.net"];

export function ipReport(env: Env, req: Request, mode: Mode, ip: string) {
  const owner = ownerOf(ip);
  const special = isSpecial(ip);
  const cf = isCloudflare(ip);
  const rev = ptrName(ip)!;

  const sections: Section[] = [
    {
      id: "owner",
      title: "Чей адрес",
      run: async () => {
        const [o, g, ptr, bt] = await Promise.all([owner, geo(ip).catch(() => []), doh(rev, "PTR", 3600).catch(() => null), bgpToolsWhois(ip)]);
        const names = answers(ptr, "PTR").map((n) => n.replace(/\.$/, ""));
        const rows: Row[] = [
          { k: "ASN", v: o.asns.map((a) => `AS${a.asn} ${a.holder}`).join(", ") || "нет", html: o.asns.map(asnLink).join("<br>") || "не анонсируется" },
          ...g,
          { k: "PTR", v: names.join(", ") || "нет", html: names.length ? names.map((n) => link(`/${n.replace(/\.$/, "")}`, n.replace(/\.$/, ""))).join("<br>") : "не настроен" },
        ];
        if (cf) rows.push({ k: "примечание", v: "Это Cloudflare: за адресом прячется чужой сайт, настоящий сервер отсюда не видно." });
        if (bt) rows.push({ k: "bgp.tools", v: bt });
        return { state: o.announced ? "up" : "none", rows, data: { asns: o.asns, prefix: o.prefix, ptr: names, geo: Object.fromEntries(g.map((r) => [r.k, r.v])), bgp_tools: bt } };
      },
    },
    {
      id: "ports",
      title: "Открытые порты и сервисы",
      run: async () => {
        const d = await getJson<any>(`https://internetdb.shodan.io/${ip}`, { ttl: 3600, allow404: true, timeout: 5000 });
        if (!d) return { state: "none", note: "Shodan InternetDB", rows: [{ k: "сканы", v: "Shodan ничего не нашёл. Или тут пусто, или файрвол хорошо настроен." }], data: null };
        const vulns: string[] = d.vulns ?? [];
        const rows: Row[] = [
          { k: "порты", v: (d.ports ?? []).join(", ") || "нет", html: (d.ports ?? []).map((p: number) => code(String(p))).join(" ") || "нет" },
        ];
        if (d.hostnames?.length) rows.push({ k: "хостнеймы", v: d.hostnames.join(", "), html: d.hostnames.slice(0, 12).map((n: string) => link(`/${n}`, n)).join(", ") });
        if (d.cpes?.length) rows.push({ k: "софт (CPE)", v: d.cpes.join(", "), html: d.cpes.slice(0, 15).map((c: string) => code(c.replace(/^cpe:\/a:/, ""))).join(" ") });
        if (d.tags?.length) rows.push({ k: "теги", v: d.tags.join(", ") });
        if (vulns.length) rows.push({ k: `CVE (${vulns.length})`, v: vulns.join(", "), html: vulns.slice(0, 30).map((v) => ext(`https://nvd.nist.gov/vuln/detail/${v}`, v)).join(", ") + (vulns.length > 30 ? ` и ещё ${vulns.length - 30}` : "") });
        return { state: vulns.length ? "down" : d.ports?.length ? "up" : "none", note: vulns.length ? "есть известные уязвимости" : "Shodan InternetDB", rows, data: d };
      },
    },
    {
      id: "tcp",
      title: "TCP с эджа Cloudflare",
      run: async (): Promise<Result> => {
        if (special) return { state: "none", rows: [{ k: "проверка", v: "Частный или служебный адрес. Из интернета его не видно, и это нормально." }] };
        if (cf) return { state: "none", rows: [{ k: "проверка", v: "Workers не подключаются к адресам Cloudflare, поэтому пингуем из разных стран через Globalping." }], html: `<p style="margin:.6rem 0 0">${link(`/check/${ip}?t=ping`, "Пинг из разных стран")}</p>` };
        const colo = ((req.cf?.colo as string) ?? /^[A-Z]{3}$/.exec(req.headers.get("x-hp-colo") ?? "")?.[0] ?? "?");
        const ports = [22, 80, 443];
        const res = await Promise.all(ports.map((p) => tcpProbe(ip, p, 2500)));
        const open = res.filter((r) => r.ms !== null);
        const best = open.length ? Math.min(...open.map((r) => r.ms!)) : null;
        return {
          state: !open.length ? "down" : best! > 150 ? "slow" : "up",
          note: `из ${colo}`,
          rows: ports.map((p, i) => ({ k: `:${p}`, v: res[i].ms !== null ? `${res[i].ms} мс` : res[i].err ?? "нет ответа" })),
          html: `<p style="margin:.6rem 0 0;font-size:.875rem">${link(`/ping/${ip}`, "Подробный пинг")} · ${link(`/check/${ip}?t=ping`, "ICMP из разных стран")}</p>`,
          data: Object.fromEntries(ports.map((p, i) => [p, res[i]])),
        };
      },
    },
    {
      id: "rep",
      title: "Репутация и блоклисты",
      run: async () => {
        const isV4 = v4(ip) !== null;
        const rip = ip.split(".").reverse().join(".");
        const [bl, tor, ...dnsbl] = await Promise.all([
          ripe("blocklist", { resource: ip }, 3600).catch(() => null),
          getJson<any>(`https://onionoo.torproject.org/summary?search=${ip}`, { ttl: 3600, timeout: 4000 }).catch(() => null),
          ...(isV4 ? DNSBL.map((z) => doh(`${rip}.${z}`, "A", 900).then((r) => answers(r, "A")).catch(() => null)) : []),
        ]);
        const hits = DNSBL.filter((_, i) => dnsbl[i]?.length && !dnsbl[i]!.some((a) => a.startsWith("127.255.")));
        const ripeHits: string[] = (bl?.sources ?? []).filter((s: any) => s.entries?.length).map((s: any) => s.source);
        const relays = [...(tor?.relays ?? []), ...(tor?.bridges ?? [])];
        const rows: Row[] = [
          { k: "DNSBL", v: isV4 ? (hits.length ? `в списках: ${hits.join(", ")}` : `чисто в ${DNSBL.length} списках`) : "для IPv6 не проверяем" },
          { k: "RIPEstat blocklist", v: ripeHits.length ? ripeHits.join(", ") : "чисто" },
          { k: "Tor", v: relays.length ? `узел Tor: ${relays.map((r: any) => r.n).join(", ")}` : "не узел Tor" },
        ];
        return {
          state: hits.length || ripeHits.length ? "down" : relays.length ? "slow" : "up",
          note: hits.length || ripeHits.length ? "засветился" : "",
          rows,
          html: `<p style="margin:.6rem 0 0;font-size:.875rem">Глубже: ${ext(`https://www.abuseipdb.com/check/${ip}`, "AbuseIPDB")} · ${ext(`https://viz.greynoise.io/ip/${ip}`, "GreyNoise")} · ${ext(`https://www.virustotal.com/gui/ip-address/${ip}`, "VirusTotal")}</p>`,
          data: { dnsbl: hits, ripe: ripeHits, tor: relays },
        };
      },
    },
    graphSection(env, req, () => owner.then((o) => (o.announced && o.prefix ? [o.prefix] : []))),
    routingSection(owner, ip),
    whoisSection(ip),
  ];

  const links = [
    ["bgp.tools", `https://bgp.tools/prefix/${ip}`],
    ["Shodan", `https://www.shodan.io/host/${ip}`],
    ["Censys", `https://search.censys.io/hosts/${ip}`],
    ["bgp.he.net", `https://bgp.he.net/ip/${ip}`],
    ["RIPEstat", `https://stat.ripe.net/${ip}`],
    ["ipinfo", `https://ipinfo.io/${ip}`],
    ["Cloudflare Radar", `https://radar.cloudflare.com/ip/${ip}`],
  ];
  return report(env, req, mode, {
    title: ip,
    slot: "hosting",
    desc: `Всё про ${ip}: владелец, ASN, порты, CVE, RPKI, whois, блоклисты.`,
    q: ip,
    hero: `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">${h(ip)}</h1><p class="lede">IPv${v4(ip) !== null ? 4 : 6}. Собираем всё, что про него знает интернет, из открытых источников.</p>${quick(ip)}`,
    heroText: `# ${ip}`,
    after: `<p class="more">Смотреть там же: ${links.map(([n, u]) => ext(u, n)).join(" · ")}</p>`,
  }, sections);
}

const quick = (t: string) =>
  `<nav class="quick" aria-label="Другие проверки">${[
    [`/ping/${t}`, "TCP-пинг"],
    [`/check/${t}?t=ping`, "Пинг из стран"],
    [`/check/${t}?t=tcp`, "TCP из стран"],
    [`/check/${t}?t=http`, "HTTP из стран"],
  ].map(([u, l]) => link(u, l)).join("")}</nav>`;

// ---------- префикс ----------

export function prefixReport(env: Env, req: Request, mode: Mode, p: string) {
  const owner = ownerOf(p);
  const sections: Section[] = [
    {
      id: "owner",
      title: "Владелец",
      run: async () => {
        const [o, g] = await Promise.all([owner, geo(p).catch(() => [])]);
        return { state: o.announced ? "up" : "down", rows: [{ k: "ASN", v: o.asns.map((a) => `AS${a.asn} ${a.holder}`).join(", ") || "нет", html: o.asns.map(asnLink).join("<br>") || "не анонсируется" }, ...g], data: o };
      },
    },
    routingSection(owner, p),
    graphSection(env, req, () => owner.then((o) => (o.announced && o.prefix ? [o.prefix] : []))),
    {
      id: "calc",
      title: "Арифметика",
      run: async () => {
        const c = calc(p)!;
        return { state: "up", rows: c.rows, html: `<p style="margin:.6rem 0 0;font-size:.875rem">${link(`/calc/${c.cidr}`, "Калькулятор")} · пополам: ${c.split.map((s) => link(`/${s}`, s)).join(", ")}</p>`, data: Object.fromEntries(c.rows.map((r) => [r.k, r.v])) };
      },
    },
    whoisSection(p),
  ];
  return report(env, req, mode, {
    title: p,
    slot: "subnets",
    desc: `Префикс ${p}: кто анонсирует, RPKI, видимость, whois.`,
    q: p,
    hero: `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">${h(p)}</h1><p class="lede">Префикс. Кто анонсирует, валиден ли по RPKI и насколько его видно в мире.</p>`,
    heroText: `# ${p}`,
    after: `<p class="more">Смотреть там же: ${ext(`https://bgp.tools/prefix/${p}`, "bgp.tools")} · ${ext(`https://bgp.he.net/net/${p}`, "bgp.he.net")} · ${ext(`https://stat.ripe.net/${p}`, "RIPEstat")}</p>`,
  }, sections);
}

// ---------- ASN ----------

export function asnReport(env: Env, req: Request, mode: Mode, n: number) {
  const as = `AS${n}`;
  const ov = ripe("as-overview", { resource: as }, 3600);
  const sections: Section[] = [
    {
      id: "overview",
      title: "Кто это",
      run: async () => {
        const [o, pdb] = await Promise.all([ov, getJson<any>(`https://www.peeringdb.com/api/net?asn=${n}`, { ttl: 86400, timeout: 5000 }).catch(() => null)]);
        const net = pdb?.data?.[0];
        const rows: Row[] = [{ k: "владелец", v: o?.holder ?? "неизвестно" }, { k: "анонсирует", v: o?.announced ? "да" : "нет" }];
        if (o?.block?.desc) rows.push({ k: "блок ASN", v: `${o.block.resource}, ${o.block.desc}` });
        if (net) {
          if (net.website) rows.push({ k: "сайт", v: net.website, html: ext(net.website, net.website.replace(/^https?:\/\//, "")) });
          if (net.info_type) rows.push({ k: "тип сети", v: net.info_type });
          if (net.policy_general) rows.push({ k: "пиринг", v: net.policy_general });
          if (net.irr_as_set) rows.push({ k: "AS-SET", v: net.irr_as_set });
          if (net.info_traffic) rows.push({ k: "трафик", v: net.info_traffic });
          if (net.info_prefixes4 || net.info_prefixes6) rows.push({ k: "макс. префиксов", v: `v4 ${net.info_prefixes4 ?? "—"}, v6 ${net.info_prefixes6 ?? "—"}` });
        }
        return { state: o?.announced ? "up" : "down", note: net ? "RIPEstat + PeeringDB" : "RIPEstat", rows, data: { overview: o, peeringdb: net } };
      },
    },
    {
      id: "prefixes",
      title: "Анонсы",
      run: async () => {
        const d = await ripe("ris-prefixes", { resource: as, list_prefixes: "false" }, 3600);
        const c = d?.counts ?? {};
        const v4n = c.v4?.originating ?? 0, v6n = c.v6?.originating ?? 0;
        return {
          state: v4n + v6n ? "up" : "none",
          rows: [{ k: "IPv4 префиксов", v: num(v4n) }, { k: "IPv6 префиксов", v: num(v6n) }, { k: "транзитом", v: `v4 ${num(c.v4?.transiting ?? 0)}, v6 ${num(c.v6?.transiting ?? 0)}` }],
          html: `<p style="margin:.6rem 0 0;font-size:.875rem">Полный список: ${ext(`https://bgp.tools/as/${n}#prefixes`, "bgp.tools")} · ${ext(`https://bgp.he.net/${as}#_prefixes`, "bgp.he.net")}</p>`,
          data: c,
        };
      },
    },
    graphSection(env, req, async () => {
      const d = await ripe("announced-prefixes", { resource: as }, 3600, 10000).catch(() => null);
      const list: string[] = (d?.prefixes ?? []).map((x: any) => x.prefix);
      // самые крупные агрегаты лучше всего описывают сеть целиком
      const biggest = (v6: boolean) => list.filter((x) => x.includes(":") === v6).sort((x, y) => Number(x.split("/")[1]) - Number(y.split("/")[1]))[0];
      return [biggest(false), biggest(true)].filter(Boolean) as string[];
    }),
    {
      id: "neighbours",
      title: "Соседи по BGP",
      run: async () => {
        const d = await ripe("asn-neighbours", { resource: as }, 3600);
        const list: any[] = d?.neighbours ?? [];
        const top = (t: string) => list.filter((x) => x.type === t).sort((a, b) => b.power - a.power);
        const up = top("left"), down = top("right");
        const fmt = (xs: any[]) => xs.slice(0, 8).map((x) => link(`/AS${x.asn}`, `AS${x.asn}`)).join(", ") + (xs.length > 8 ? ` и ещё ${xs.length - 8}` : "");
        return {
          state: list.length ? "up" : "none",
          rows: [
            { k: `апстримы (${up.length})`, v: up.slice(0, 8).map((x) => `AS${x.asn}`).join(", ") || "нет", html: fmt(up) || "нет" },
            { k: `клиенты (${down.length})`, v: down.slice(0, 8).map((x) => `AS${x.asn}`).join(", ") || "нет", html: fmt(down) || "нет" },
          ],
          data: { upstreams: up.map((x) => x.asn), downstreams: down.map((x) => x.asn) },
        };
      },
    },
    {
      id: "ix",
      title: "Точки обмена трафиком",
      run: async () => {
        const d = await getJson<any>(`https://www.peeringdb.com/api/netixlan?asn=${n}`, { ttl: 86400, timeout: 6000 });
        const ixs = new Map<string, number>();
        for (const x of d?.data ?? []) ixs.set(x.name, (ixs.get(x.name) ?? 0) + (x.speed ?? 0));
        if (!ixs.size) return { state: "none", rows: [{ k: "IX", v: "Нет в PeeringDB. Либо не пирится, либо ленится заполнять." }] };
        const sorted = [...ixs].sort((a, b) => b[1] - a[1]);
        const gbps = (m: number) => (m >= 1000 ? `${num(m / 1000)} Гбит/с` : `${m} Мбит/с`);
        return {
          state: "up",
          note: `${ixs.size} шт., PeeringDB`,
          rows: sorted.slice(0, 12).map(([name, sp]) => ({ k: name, v: gbps(sp) })),
          html: sorted.length > 12 ? `<p style="margin:.6rem 0 0;font-size:.875rem">и ещё ${sorted.length - 12}</p>` : "",
          data: Object.fromEntries(sorted),
        };
      },
    },
    whoisSection(as),
  ];
  return report(env, req, mode, {
    title: as,
    slot: "subnets",
    desc: `${as}: владелец, анонсы, апстримы, IX, whois.`,
    q: as,
    hero: `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">${as}</h1><p class="lede">Автономная система. Кто держит, что анонсирует и с кем связан.</p>`,
    heroText: `# ${as}`,
    after: `<p class="more">Смотреть там же: ${[["bgp.tools", `https://bgp.tools/as/${n}`], ["bgp.he.net", `https://bgp.he.net/${as}`], ["PeeringDB", `https://www.peeringdb.com/asn/${n}`], ["Cloudflare Radar", `https://radar.cloudflare.com/${as.toLowerCase()}`], ["RIPEstat", `https://stat.ripe.net/${as}`]].map(([l, u]) => ext(u, l)).join(" · ")}</p>`,
  }, sections);
}

// ---------- домен ----------

const RU_WHOIS = /\.(ru|su|xn--p1ai)$/;

async function tcpWhois(server: string, q: string) {
  return withTimeout(
    (async () => {
      const sock = connect({ hostname: server, port: 43 });
      const wr = sock.writable.getWriter();
      await wr.write(new TextEncoder().encode(q + "\r\n"));
      const out = await new Response(sock.readable).text();
      sock.close().catch(() => {});
      return out;
    })(),
    4000,
  );
}

export function hostReport(env: Env, req: Request, mode: Mode, host: string) {
  const dA = doh(host, "A").catch(() => null);
  const dAAAA = doh(host, "AAAA").catch(() => null);
  const firstIp = Promise.all([dA, dAAAA]).then(([a, b]) => answers(a, "A")[0] ?? answers(b, "AAAA")[0] ?? null);

  const sections: Section[] = [
    {
      id: "dns",
      title: "DNS",
      run: async () => {
        const [a, aaaa, ns, mx, txt, caa, dmarc] = await Promise.all([dA, dAAAA, doh(host, "NS"), doh(host, "MX"), doh(host, "TXT"), doh(host, "CAA"), doh(`_dmarc.${host}`, "TXT")].map((p) => p.catch(() => null)));
        if (a && a.Status !== 0) return { state: "down", note: RCODE[a.Status] ?? `код ${a.Status}`, rows: [{ k: "ответ", v: a.Status === 3 ? "NXDOMAIN: такого имени нет. Проверь опечатку или NS у регистратора." : `Резолвер вернул ${RCODE[a.Status] ?? a.Status}. Скорее всего, сломаны NS или DNSSEC.` }] };
        const cname = (a?.Answer ?? []).filter((x) => x.type === 5).map((x) => x.data);
        const spf = answers(txt, "TXT").find((t) => t.includes("v=spf1"));
        const dm = answers(dmarc, "TXT").find((t) => t.includes("v=DMARC1"));
        const ips = [...answers(a, "A"), ...answers(aaaa, "AAAA")];
        const rows: Row[] = [
          ...(cname.length ? [{ k: "CNAME", v: cname.join(" → ") }] : []),
          { k: "A / AAAA", v: ips.join(", ") || "нет", html: ips.map((ip) => link(`/${ip}`, ip)).join("<br>") || "нет" },
          { k: "NS", v: answers(ns, "NS").join(", ") || "нет" },
          { k: "MX", v: answers(mx, "MX").join(", ") || "нет" },
          { k: "SPF", v: spf ?? "нет", html: spf ? code(spf) : "нет: письма с домена легко подделать" },
          { k: "DMARC", v: dm ?? "нет", html: dm ? code(dm) : "нет" },
          { k: "CAA", v: answers(caa, "CAA").join(", ") || "нет, сертификат может выпустить любой CA" },
          { k: "DNSSEC", v: a?.AD ? "подписан, AD-флаг есть" : "не подписан" },
        ];
        return { state: ips.length ? "up" : "down", note: "1.1.1.1", rows, html: `<p style="margin:.6rem 0 0;font-size:.875rem">${link(`/dns/${host}`, "Все записи")}</p>`, data: { ips, cname, ns: answers(ns, "NS"), mx: answers(mx, "MX"), spf, dmarc: dm, dnssec: !!a?.AD } };
      },
    },
    {
      id: "http",
      title: "HTTP",
      run: async () => {
        const t0 = Date.now();
        const r = await fetch(`https://${host}/`, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "host.pink/1.0 (+https://host.pink/tools/)" } });
        const ms = Date.now() - t0;
        r.body?.cancel().catch(() => {});
        const hd = (k: string) => r.headers.get(k);
        const rows: Row[] = [
          { k: "ответ", v: `${r.status} ${r.statusText}`.trim() },
          { k: "время", v: `${ms} мс до заголовков` },
        ];
        if (hd("location")) rows.push({ k: "редирект", v: hd("location")! });
        if (hd("server")) rows.push({ k: "сервер", v: hd("server")! });
        if (hd("cf-ray")) rows.push({ k: "CDN", v: "за Cloudflare" });
        else if (hd("x-served-by") || hd("x-cache")) rows.push({ k: "CDN", v: hd("x-served-by") ?? hd("x-cache")! });
        // есть ли перед сервером хоть какая-то защита от DDoS
        const guard = hd("cf-ray") ? "Cloudflare" : /qrator|ddos-guard|stormwall|variti|curator|akamai|fastly|sucuri|imperva|incapsula|turtleguard/i.exec(`${hd("server") ?? ""} ${hd("x-cdn") ?? ""} ${hd("x-sucuri-id") ? "sucuri" : ""} ${hd("x-iinfo") ? "imperva" : ""}`)?.[0];
        if (guard) rows.push({ k: "DDoS-защита", v: guard });
        else {
          const sp = pickSponsor("ddos");
          rows.push({
            k: "DDoS-защита",
            v: "не видно ни CDN, ни WAF: сервер торчит в интернет напрямую",
            html: sp
              ? `не видно ни CDN, ни WAF: сервер торчит в интернет напрямую. <a href="${sp.url}?utm_source=host.pink&utm_medium=sponsor&utm_campaign=dossier-nodefense" rel="sponsored noopener">${h(sp.name)}</a> закрывает это одной DNS-записью <small>(реклама)</small>`
              : "не видно ни CDN, ни WAF: сервер торчит в интернет напрямую",
          });
        }
        rows.push({ k: "HSTS", v: hd("strict-transport-security") ?? "нет" });
        if (hd("alt-svc")?.includes("h3")) rows.push({ k: "HTTP/3", v: "объявлен в alt-svc" });
        const sec = ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"].filter((k) => hd(k));
        rows.push({ k: "заголовки защиты", v: sec.length ? sec.join(", ") : "ни одного. Смело." });
        return { state: r.status >= 500 ? "down" : ms > 1500 ? "slow" : "up", note: "HTTPS из Cloudflare", rows, data: { status: r.status, ms, headers: Object.fromEntries(r.headers) } };
      },
    },
    {
      id: "ru",
      title: "Доступность из РФ",
      run: async (): Promise<Result> => {
        let res: Awaited<ReturnType<typeof runAndWait>>;
        try {
          res = await runAndWait(env, "http", host, undefined, WHERE_RU, 11000);
        } catch (e) {
          const edge = await edgeCheck(req, "http", host);
          return {
            state: "none",
            note: "Globalping недоступен",
            rows: [{ k: edge.city, v: edge.text, html: `<span class="st st-${edge.state}"></span>${h(edge.text)}` }, { k: "причина", v: errText(e) }],
            html: `<p style="margin:.6rem 0 0;font-size:.875rem">Проверить руками: ${manualLinks(host).map(([n, u]) => ext(u, n)).join(" · ")}</p>`,
          };
        }
        const rows: Row[] = res.rows.map((r) => ({
          k: `${r.city}, ${r.cc}${r.home ? " (дом.)" : ""}`,
          v: `${r.text || "ещё проверяет"} — ${r.network}`,
          html: `<span class="st st-${r.state}"></span>${h(r.text || "ещё проверяет")}<br><small>${h(r.network)}</small>`,
        }));
        const ru = res.rows.filter((r) => r.cc === "RU" && r.state !== "none");
        const ruOk = ru.filter((r) => r.state !== "down").length;
        const abroadOk = res.rows.filter((r) => r.cc !== "RU" && (r.state === "up" || r.state === "slow")).length;
        const note = !ru.length ? "российские пробы не ответили" : ruOk === ru.length ? "открыт" : ruOk === 0 && abroadOk ? "похоже, заблокирован в РФ" : ruOk === 0 ? "лежит для всех" : "у части провайдеров не открывается";
        return {
          state: !ru.length ? "none" : ruOk === ru.length ? "up" : ruOk ? "slow" : "down",
          note,
          rows,
          html: `<p style="margin:.6rem 0 0;font-size:.875rem">${link(`/check/${host}`, "Проверить из разных стран")} · пробы Globalping, «дом.» — домашние провайдеры</p>`,
          data: { results: res.rows },
        };
      },
    },
    {
      id: "server",
      title: "Сервер",
      run: async () => {
        const ip = await firstIp;
        if (!ip) return { skip: true };
        const [o, g] = await Promise.all([ownerOf(ip), geo(ip).catch(() => [])]);
        const cf = isCloudflare(ip);
        const probe = cf || isSpecial(ip) ? null : await tcpProbe(ip, 443);
        const rows: Row[] = [
          { k: "IP", v: ip, html: link(`/${ip}`, ip) + " — полное досье" },
          { k: "ASN", v: o.asns.map((a) => `AS${a.asn} ${a.holder}`).join(", "), html: o.asns.map(asnLink).join("<br>") },
          ...g,
          { k: "TCP :443", v: cf ? "Cloudflare, настоящий сервер спрятан" : probe?.ms != null ? `${probe.ms} мс с эджа ${req.cf?.colo ?? ""}` : probe?.err ?? "нет ответа" },
        ];
        return { state: probe && probe.ms == null ? "down" : "up", rows, data: { ip, asns: o.asns, tcp443: probe } };
      },
    },
    {
      id: "ct",
      title: "Сертификаты и поддомены",
      run: async (): Promise<Result> => {
        const apex = host.split(".").slice(-2).join(".");
        const r = await fetch(`https://api.certspotter.com/v1/issuances?domain=${apex}&include_subdomains=true&expand=dns_names&expand=issuer`, {
          headers: { "user-agent": "host.pink/1.0 (+https://host.pink/tools/)" },
          signal: AbortSignal.timeout(7000),
          cf: { cacheTtl: 21600, cacheEverything: true },
        });
        if (r.status === 429) throw new Error("лимит Cert Spotter на этот час исчерпан");
        if (!r.ok) throw new Error(`Cert Spotter ответил HTTP ${r.status}`);
        const certs = (await r.json()) as { dns_names: string[]; issuer?: { friendly_name?: string; name?: string }; not_before: string; not_after: string }[];
        const covers = (c: (typeof certs)[number]) => c.dns_names.some((n) => n === host || (n.startsWith("*.") && host.endsWith(n.slice(1)) && host.split(".").length === n.split(".").length));
        const mine = certs.filter(covers).sort((a, b) => b.not_after.localeCompare(a.not_after));
        const subs = [...new Set(certs.flatMap((c) => c.dns_names).map((n) => n.replace(/^\*\./, "")).filter((n) => n.endsWith(apex) && n !== apex))].sort();
        const rows: Row[] = [];
        let state: Result["state"] = "none";
        if (mine[0]) {
          const days = Math.floor((Date.parse(mine[0].not_after) - Date.now()) / 86400000);
          state = days < 7 ? "down" : days < 21 ? "slow" : "up";
          rows.push(
            { k: "выпустил", v: mine[0].issuer?.friendly_name ?? mine[0].issuer?.name ?? "?" },
            { k: "действует до", v: `${ago(mine[0].not_after)}, осталось ${days} дн.${days < 21 ? " Продлевай, пока не поздно." : ""}` },
            { k: "имена в серте", v: mine[0].dns_names.slice(0, 8).join(", ") + (mine[0].dns_names.length > 8 ? ` и ещё ${mine[0].dns_names.length - 8}` : "") },
            { k: "действующих", v: `${mine.length} на ${host}, ${certs.length} на всю зону ${apex}` },
          );
        } else {
          rows.push({ k: "сертификаты", v: `В CT-логах нет действующего сертификата на ${host}.` });
        }
        if (subs.length) {
          rows.push({
            k: `поддомены (${subs.length})`,
            v: subs.slice(0, 40).join(", "),
            html: subs.slice(0, 40).map((n) => link(`/${n}`, n)).join(", ") + (subs.length > 40 ? ` и ещё ${subs.length - 40}` : ""),
          });
        }
        return {
          state,
          note: "Certificate Transparency",
          rows,
          html: `<p style="margin:.6rem 0 0;font-size:.875rem">Поддомены видны, потому что на них выпускали сертификаты. Полная история: ${ext(`https://crt.sh/?q=${apex}`, "crt.sh")}</p>`,
          data: { certs: mine.slice(0, 5), subdomains: subs },
        };
      },
    },
    {
      id: "reg",
      title: "Регистрация домена",
      run: async () => {
        const apex = host.split(".").slice(-2).join(".");
        if (RU_WHOIS.test(apex)) {
          const out = await tcpWhois("whois.tcinet.ru", apex);
          const get = (k: string) => out.match(new RegExp(`^${k}:\\s*(.+)$`, "mi"))?.[1]?.trim();
          const rows: Row[] = [
            { k: "регистратор", v: get("registrar") ?? "?" },
            { k: "создан", v: get("created") ?? "?" },
            { k: "оплачен до", v: get("paid-till") ?? "?" },
            { k: "статус", v: get("state") ?? "?" },
          ];
          return { state: "up", note: "whois.tcinet.ru", rows, html: `<details><summary>Сырой whois</summary><pre>${h(out.slice(0, 6000))}</pre></details>`, data: Object.fromEntries(rows.map((r) => [r.k, r.v])) };
        }
        const d = await getJson<any>(`https://rdap.org/domain/${apex}`, { ttl: 3600, timeout: 6000, allow404: true });
        if (!d) return { state: "none", rows: [{ k: "RDAP", v: "Реестр зоны не отдаёт RDAP. Смотри whois у регистратора." }] };
        const ev = (a: string) => ago(d.events?.find((e: any) => e.eventAction === a)?.eventDate);
        const registrar = d.entities?.find((e: any) => e.roles?.includes("registrar"));
        const rname = registrar?.vcardArray?.[1]?.find((x: any) => x[0] === "fn")?.[3] ?? registrar?.handle;
        const rows: Row[] = [
          { k: "регистратор", v: rname ?? "?" },
          { k: "создан", v: ev("registration") || "?" },
          { k: "истекает", v: ev("expiration") || "?" },
          { k: "обновлён", v: ev("last changed") || "?" },
          { k: "статус", v: (d.status ?? []).join(", ") || "?" },
        ];
        return { state: "up", note: "RDAP", rows, data: { registrar: rname, events: d.events, status: d.status } };
      },
    },
  ];

  return report(env, req, mode, {
    title: host,
    slot: "domains",
    desc: `Досье ${host}: DNS, HTTP, доступность из РФ, сервер и регистрация.`,
    q: host,
    hero: `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">${h(host)}</h1><p class="lede">Досье домена. Карточки приходят по мере ответа источников, доступность из РФ — самая медленная.</p>${quick(host)}`,
    heroText: `# ${host}`,
    after: `<p class="more">Смотреть там же: ${[["crt.sh", `https://crt.sh/?q=${host}`], ["SSL Labs", `https://www.ssllabs.com/ssltest/analyze.html?d=${host}`], ["securitytrails", `https://securitytrails.com/domain/${host}/dns`], ["Censys", `https://search.censys.io/search?resource=hosts&q=${host}`], ["Radar", `https://radar.cloudflare.com/domains/domain/${host}`]].map(([l, u]) => ext(u, l)).join(" · ")}</p>`,
  }, sections);
}
