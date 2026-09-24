import { answers, classify, doh, isCloudflare, isSpecial, PING_PORTS, RCODE, RR, RR_NAME, tcpProbe } from "./net";
import { CHECK_TYPES, type CheckType, edgeCheck, fetchResult, manualLinks, ProbeError, start } from "./probes";
import { json, link, page, text, wrap, ext } from "./shell";
import { errText, h, type Mode } from "./util";

const hero = (title: string, lede: string, crumbs = true) =>
  `${crumbs ? `<p class="crumbs"><a href="/tools/">Тулзы</a></p>` : ""}<h1 class="hero-ip">${h(title)}</h1><p class="lede">${lede}</p>`;

const kv = (rows: [string, string][]) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;

// ---------- /ip ----------
export async function myIp(env: Env, req: Request, url: URL, mode: Mode) {
  const ip = req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const cf = (req.cf ?? {}) as Record<string, any>;
  const info = {
    ip,
    asn: cf.asn,
    org: cf.asOrganization,
    country: cf.country,
    region: cf.region,
    city: cf.city,
    timezone: cf.timezone,
    colo: cf.colo,
    http: cf.httpProtocol,
    tls: cf.tlsVersion,
    cipher: cf.tlsCipher,
    rtt_ms: cf.clientTcpRtt,
  };
  if (mode === "json") return json(info);
  if (mode === "text") {
    if (!url.searchParams.has("full")) return text(ip);
    return text(Object.entries(info).map(([k, v]) => `${k.padEnd(9)} ${v ?? ""}`).join("\n"));
  }
  const rows: [string, string][] = [
    ["провайдер", `${link(`/AS${info.asn}`, `AS${info.asn}`)} ${h(info.org ?? "")}`],
    ["где", h([info.city, info.region, info.country].filter(Boolean).join(", "))],
    ["часовой пояс", h(info.timezone ?? "")],
    ["дата-центр CF", `<code>${h(info.colo)}</code>`],
    ["протокол", h(`${info.http ?? ""}, ${info.tls ?? ""} ${info.cipher ?? ""}`)],
  ];
  if (info.rtt_ms) rows.push(["RTT до CF", `${info.rtt_ms} мс`]);
  return page(env, req, { title: "Мой IP", nav: "/tools/", slot: "hosting" }, wrap(
    hero(ip, "Это твой адрес, каким его видит Cloudflare. Если сидишь через VPN, видно выход VPN.") +
    `<div class="report"><section class="card is-up"><h2><span class="st st-up"></span>Подключение</h2>${kv(rows)}</section></div>` +
    `<p class="more">${link(`/${ip}`, "Полное досье на адрес")} · В терминале: <code>curl host.pink/ip</code>, подробно: <code>curl "host.pink/ip?full"</code></p>`,
  ));
}

// ---------- /dns/:name ----------
const DNS_TYPES = ["A", "AAAA", "CNAME", "NS", "MX", "TXT", "CAA", "HTTPS", "SOA", "DS"];

export async function dnsTool(env: Env, req: Request, url: URL, mode: Mode, name: string) {
  const k = classify(name, false);
  if (!k || k.t !== "host") return bad(env, req, mode, "Это не похоже на доменное имя", `«${name}» не домен. Пример: host.pink/dns/example.com`);
  const host = k.host;
  const only = url.searchParams.get("t")?.toUpperCase();
  const types = only && RR[only] ? [only] : DNS_TYPES;
  const res = await Promise.all(types.map((t) => doh(host, t, 30).catch(() => null)));
  const status = res.find((r) => r)?.Status ?? 2;
  const data = Object.fromEntries(types.map((t, i) => [t, (res[i]?.Answer ?? []).filter((a) => a.type === RR[t]).map((a) => ({ data: a.data, ttl: a.TTL }))]));
  const ad = res.some((r) => r?.AD);
  if (mode === "json") return json({ name: host, status: RCODE[status] ?? status, dnssec: ad, records: data });
  if (mode === "text") {
    const lines = [`; ${host} — ${RCODE[status] ?? status}${ad ? ", DNSSEC ok" : ""}`];
    for (const t of types) for (const r of data[t]) lines.push(`${t.padEnd(6)} ${String(r.ttl).padStart(6)}  ${r.data}`);
    return text(lines.join("\n"));
  }
  const tabs = `<nav class="quick">${[["", "Все"], ...DNS_TYPES.map((t) => [t, t])].map(([t, l]) => `<a href="/dns/${h(host)}${t ? `?t=${t}` : ""}"${(only ?? "") === t ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
  const cards = types
    .map((t) => {
      const recs = data[t];
      if (!recs.length && !only) return "";
      const body = recs.length
        ? `<dl class="kv">${recs.map((r) => `<dt>TTL ${r.ttl}</dt><dd>${t === "A" || t === "AAAA" ? link(`/${r.data}`, r.data) : h(r.data)}</dd>`).join("")}</dl>`
        : `<p style="margin:0;color:var(--ink-2)">Записей нет.</p>`;
      return `<section class="card ${recs.length ? "is-up" : ""}"><h2><span class="st ${recs.length ? "st-up" : "st-none"}"></span>${t} <small>${recs.length} шт.</small></h2>${body}</section>`;
    })
    .join("");
  const empty = status === 3 ? `<div class="callout callout-warning"><p class="callout-t">NXDOMAIN</p><p>Такого имени нет. Проверь опечатку, делегирование у регистратора и NS-записи родительской зоны.</p></div>` : "";
  return page(env, req, { title: `DNS ${host}`, nav: "/tools/", q: host, slot: "domains" }, wrap(
    hero(host, `DNS-записи через DoH 1.1.1.1. Ответ: <b>${h(RCODE[status] ?? status)}</b>${ad ? ", DNSSEC проверен" : ", без DNSSEC"}.`) + tabs + empty + `<div class="report">${cards}</div>` +
    `<p class="more">${link(`/${host}`, "Досье домена")} · В терминале: <code>curl host.pink/dns/${h(host)}</code></p>`,
  ));
}

// ---------- /ping/:target ----------
export async function pingTool(env: Env, req: Request, url: URL, mode: Mode, target: string) {
  const isV6 = (target.match(/:/g) ?? []).length > 1;
  const m = isV6 ? null : target.match(/^(.+?)(?::(\d{1,5}))?$/);
  const port = Number(url.searchParams.get("port") ?? m?.[2] ?? 443);
  const k = classify(m?.[1] ?? target, false);
  if (!k || (k.t !== "ip" && k.t !== "host")) return bad(env, req, mode, "Непонятная цель", `«${target}» не IP и не домен. Пример: host.pink/ping/8.8.8.8:53`);
  if (!PING_PORTS.has(port)) return bad(env, req, mode, `Порт ${port} не из списка`, `Проверяем только популярные порты: ${[...PING_PORTS].join(", ")}. Сканер портов — это в Shodan.`);
  let ip = k.t === "ip" ? k.ip : null;
  if (k.t === "host") {
    const [a, b] = await Promise.all([doh(k.host, "A"), doh(k.host, "AAAA")].map((p) => p.catch(() => null)));
    ip = answers(a, "A")[0] ?? answers(b, "AAAA")[0] ?? null;
    if (!ip) return bad(env, req, mode, "Имя не резолвится", `У ${k.host} нет A и AAAA записей. Пинговать нечего.`);
  }
  const label = k.t === "host" ? k.host : ip!;
  if (isSpecial(ip!)) return bad(env, req, mode, "Частный адрес", `${ip} — частный или служебный адрес. Из интернета его не видно.`);
  if (isCloudflare(ip!)) return bad(env, req, mode, "Это адрес Cloudflare", `${ip} принадлежит Cloudflare, а Workers к таким адресам не подключаются. Проверь пингом из разных стран: host.pink/check/${label}?t=ping`, `/check/${label}?t=ping`);

  const colo = ((req.cf?.colo as string) ?? /^[A-Z]{3}$/.exec(req.headers.get("x-hp-colo") ?? "")?.[0] ?? "?");
  const probes = [];
  for (let i = 0; i < 4; i++) probes.push(await tcpProbe(ip!, port, 3000));
  const ok = probes.filter((p) => p.ms !== null).map((p) => p.ms!);
  const stat = ok.length ? { min: Math.min(...ok), avg: Math.round(ok.reduce((a, b) => a + b, 0) / ok.length), max: Math.max(...ok) } : null;
  if (mode === "json") return json({ target: label, ip, port, colo, probes, stat, loss: 4 - ok.length });
  if (mode === "text")
    return text([`TCP ${label} (${ip}):${port} из ${colo}`, ...probes.map((p, i) => `  seq=${i + 1} ${p.ms !== null ? `${p.ms} ms` : p.err}`), stat ? `  min/avg/max = ${stat.min}/${stat.avg}/${stat.max} ms, потерь ${4 - ok.length}/4` : "  не ответил ни разу"].join("\n"));

  const max = Math.max(...ok, 1);
  const rows = probes.map((p, i) => `<dt>#${i + 1}</dt><dd>${p.ms !== null ? `${p.ms} мс<span class="bar" style="--w:${Math.max(4, (p.ms / max) * 100)}%;--c:var(--${p.ms > 150 ? "slow" : "up"})"><i></i></span>` : `<span class="st st-down"></span>${h(p.err)}`}</dd>`).join("");
  const st = !ok.length ? "down" : stat!.avg > 150 ? "slow" : "up";
  return page(env, req, { title: `Пинг ${label}`, nav: "/tools/", q: label, slot: "network" }, wrap(
    hero(`${label}:${port}`, `TCP-пинг: время рукопожатия с дата-центра Cloudflare <code>${h(colo)}</code>. Это не ICMP, зато честно показывает, жив ли порт.`) +
    `<nav class="quick">${[22, 80, 443, 53, 8443].map((p) => `<a href="/ping/${h(label)}${label.includes(":") ? `?port=${p}` : `:${p}`}"${p === port ? ' aria-current="page"' : ""}>:${p}</a>`).join("")}</nav>` +
    `<div class="report"><section class="card is-${st}"><h2><span class="st st-${st}"></span>${h(ip)}:${port} <small>${stat ? `мин ${stat.min} / ср ${stat.avg} / макс ${stat.max} мс, потерь ${4 - ok.length} из 4` : "ни одного ответа"}</small></h2><dl class="kv">${rows}</dl></section></div>` +
    `<p class="more">${link(`/check/${label}?t=ping`, "ICMP-пинг из 20+ стран")} · ${link(`/${ip}`, "Досье на IP")} · В терминале: <code>curl host.pink/ping/${h(label)}:${port}</code></p>`,
  ));
}

// ---------- /check: Globalping, фоллбек — эдж Cloudflare ----------
function checkTarget(target: string) {
  const isV6 = (target.match(/:/g) ?? []).length > 1;
  const m = isV6 ? null : target.match(/^(.+?)(?::(\d{1,5}))?$/);
  const k = classify(m?.[1] ?? target, false);
  if (!k || (k.t !== "ip" && k.t !== "host")) return null;
  return { k, host: k.t === "host" ? k.host : k.ip, port: m?.[2] ? Number(m[2]) : undefined };
}

const tabsFor = (host: string, t: CheckType, port?: number) =>
  `<nav class="quick">${(Object.keys(CHECK_TYPES) as CheckType[]).map((k) => `<a href="/check/${h(host)}${port ? `:${port}` : ""}?t=${k}"${k === t ? ' aria-current="page"' : ""}>${CHECK_TYPES[k]}</a>`).join("")}</nav>`;

export async function checkStart(env: Env, req: Request, url: URL, mode: Mode, target: string) {
  const t = (url.searchParams.get("t") ?? "http") as CheckType;
  if (!(t in CHECK_TYPES)) return bad(env, req, mode, "Нет такого типа проверки", "Бывает http, ping, tcp, dns и mtr.");
  const tg = checkTarget(target);
  if (!tg) return bad(env, req, mode, "Непонятная цель", `«${target}» не IP и не домен.`);
  if (t === "dns" && tg.k.t !== "host") return bad(env, req, mode, "DNS-проверка только для доменов", "Для IP используй ping или tcp.");
  if (tg.k.t === "ip" && isSpecial(tg.host)) return bad(env, req, mode, "Частный адрес", `${tg.host} из интернета не видно, проверять нечего.`);

  // одинаковые проверки в течение двух минут не запускаем заново: экономим бесплатный лимит проб
  const key = `https://cache.host.pink/check/${t}/${encodeURIComponent(tg.host)}/${tg.port ?? ""}`;
  const cached = await caches.default.match(key);
  let id = cached ? await cached.text() : null;
  if (!id) {
    try {
      id = await start(env, t, tg.host, tg.port);
      await caches.default.put(key, new Response(id, { headers: { "cache-control": "public, max-age=120" } }));
    } catch (e) {
      return checkFallback(env, req, mode, t, tg.host, tg.port, errText(e));
    }
  }
  const next = `/check/r/${id}?h=${encodeURIComponent(tg.host)}${tg.port ? `&p=${tg.port}` : ""}&t=${t}&s=${Date.now()}`;
  if (mode !== "html") return checkResult(env, req, new URL(next, url), mode, id, true);
  return Response.redirect(new URL(next, url).toString(), 303);
}

async function checkFallback(env: Env, req: Request, mode: Mode, t: CheckType, host: string, port: number | undefined, why: string) {
  const row = await edgeCheck(req, t, host, port);
  if (mode === "json") return json({ host, type: t, fallback: "cloudflare-edge", reason: why, results: [row] });
  if (mode === "text") return text(`${CHECK_TYPES[t]} ${host}: проверка из разных стран недоступна (${why}).\nС эджа ${row.city}: ${row.text}`);
  return page(env, req, { title: `${CHECK_TYPES[t]} ${host}`, nav: "/tools/", q: host }, wrap(
    hero(host, `${CHECK_TYPES[t]}-проверка из разных стран сейчас недоступна: ${h(why)}. Показываем, что видно из одной точки — дата-центра Cloudflare.`) +
    tabsFor(host, t, port) +
    `<div class="report"><section class="card is-${row.state}"><h2><span class="st st-${row.state}"></span>${h(row.city)} <small>${h(row.cc)}</small></h2><dl class="kv"><dt>результат</dt><dd>${h(row.text)}</dd></dl></section></div>` +
    `<p class="more">Проверить руками: ${manualLinks(host).map(([n, u]) => ext(u, n)).join(" · ")}</p>`,
  ));
}

export async function checkResult(env: Env, req: Request, url: URL, mode: Mode, id: string, wait = false) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return bad(env, req, mode, "Кривой идентификатор проверки", "Запусти проверку заново.");
  const t = (url.searchParams.get("t") ?? "http") as CheckType;
  const host = url.searchParams.get("h") ?? "";
  const port = url.searchParams.get("p") ? Number(url.searchParams.get("p")) : undefined;
  const started = Number(url.searchParams.get("s") ?? 0);
  let res: Awaited<ReturnType<typeof fetchResult>>;
  try {
    res = await fetchResult(env, id);
    for (let i = 0; wait && !res.done && i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      res = await fetchResult(env, id);
    }
  } catch (e) {
    if (e instanceof ProbeError && e.status === 404) return bad(env, req, mode, "Проверка устарела", "Результаты хранятся 7 дней. Запусти заново.", `/check/${host}?t=${t}`, 404);
    return checkFallback(env, req, mode, t, host, port, errText(e));
  }
  const rows = [...res.rows].sort((a, b) => Number(b.cc === "RU") - Number(a.cc === "RU") || Number(b.home) - Number(a.home) || a.cc.localeCompare(b.cc));
  const pending = rows.filter((r) => r.state === "none" && !r.text).length;
  if (mode === "json") return json({ id, type: t, host, done: res.done, results: rows });
  if (mode === "text") {
    const lines = [`${CHECK_TYPES[t]} ${host} — ${rows.length} проб Globalping${res.done ? "" : ", ещё идёт"}`];
    for (const r of rows) {
      lines.push(`  ${r.cc} ${(r.city + (r.home ? " (дом.)" : "")).padEnd(24)} ${r.state === "none" && !r.text ? "…" : r.text}   ${r.network}`);
      if (r.raw) lines.push(r.raw.split("\n").map((l) => "      " + l).join("\n"));
    }
    return text(lines.join("\n"));
  }

  const fresh = !res.done && Date.now() - started < 45000;
  const ru = rows.filter((r) => r.cc === "RU" && r.state !== "none");
  const ruOk = ru.filter((r) => r.state !== "down").length;
  const world = rows.filter((r) => r.cc !== "RU" && r.state !== "none");
  const worldOk = world.filter((r) => r.state !== "down").length;
  const verdict = !res.done
    ? `Ждём ${pending || "оставшиеся"} проб, страница обновится сама.`
    : ru.length && !ruOk && worldOk
      ? "Из РФ не открывается, из мира открывается. Похоже на блокировку."
      : ru.length && ruOk < ru.length && worldOk === world.length
        ? "Из РФ открывается не у всех провайдеров. Похоже на частичную блокировку."
        : `Ответили ${rows.filter((r) => r.state === "up" || r.state === "slow").length} из ${rows.length}.`;
  const table = `<div class="table"><table><thead><tr><th>Проба</th><th>Сеть</th><th>Результат</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td><code>${h(r.cc)}</code> ${h(r.city)}${r.cc === "RU" ? " <b>РФ</b>" : ""}</td><td>${h(r.network)}${r.home ? ' <small title="домашний провайдер, как у обычных абонентов">дом.</small>' : ""}</td><td><span class="st st-${r.state}"></span>${r.state === "none" && !r.text ? `<span class="pending">проверяет</span>` : h(r.text)}${r.raw ? `<details><summary>трасса</summary><pre>${h(r.raw)}</pre></details>` : ""}</td></tr>`)
    .join("")}</tbody></table></div>`;
  return page(env, req, { title: `${CHECK_TYPES[t]} ${host}`, nav: "/tools/", q: host, slot: "network", headExtra: fresh ? `<meta http-equiv="refresh" content="2">` : "" }, wrap(
    hero(host, `${CHECK_TYPES[t]} с ${rows.length} проб по миру, из них ${rows.filter((r) => r.cc === "RU").length} в России. ${verdict}`) +
    tabsFor(host, t, port) + table +
    `<p class="more">Пробы <a href="https://globalping.io" rel="noopener">Globalping</a>: «дом.» — домашние провайдеры, там видно блокировки ТСПУ как у обычных абонентов. ${link(`/${host}`, "Досье")} · ${ext(`https://globalping.io/?measurement=${id}`, "Этот замер на globalping.io")}</p>`,
  ));
}

// ---------- ошибки ----------
export async function bad(env: Env, req: Request, mode: Mode, title: string, msg: string, action?: string, status = 400) {
  if (mode === "json") return json({ error: title, message: msg }, status);
  if (mode === "text") return text(`${title}. ${msg}`, status);
  return page(env, req, { title, status }, `<section class="void"><h1>${h(title)}</h1><p>${h(msg)}</p>${action ? `<p>${link(action, "Попробовать так")}</p>` : ""}</section>`);
}

export { RR_NAME };
