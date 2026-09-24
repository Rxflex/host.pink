// Калькулятор подсетей: чистая арифметика, ноль подзапросов
import { isSpecial, v4, v6 } from "./net";
import { json, link, page, text, wrap, type Row } from "./shell";
import { h, type Mode, num } from "./util";

const ip4 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const bin4 = (n: number) => ip4(n).split(".").map((o) => Number(o).toString(2).padStart(8, "0")).join(".");

function ip6(n: bigint) {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}

export type Calc = { v: 4 | 6; cidr: string; rows: Row[]; split: string[]; parent?: string; special: boolean };

export function calc(input: string): Calc | null {
  const m = input.trim().match(/^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/i);
  if (!m) return null;
  const a4 = v4(m[1]);
  if (a4 !== null) {
    const len = m[2] === undefined ? 32 : Number(m[2]);
    if (len > 32) return null;
    const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
    const net = (a4 & mask) >>> 0;
    const bc = (net | (~mask >>> 0)) >>> 0;
    const total = 2 ** (32 - len);
    const p2p = len >= 31;
    const rows: Row[] = [
      { k: "сеть", v: `${ip4(net)}/${len}` },
      { k: "маска", v: `${ip4(mask)} (/${len})` },
      { k: "wildcard", v: ip4(~mask >>> 0) },
      { k: "broadcast", v: p2p ? "нет (/31 и /32)" : ip4(bc) },
      { k: "хосты", v: p2p ? `${ip4(net)} — ${ip4(bc)}` : `${ip4(net + 1)} — ${ip4(bc - 1)}` },
      { k: "адресов", v: `${num(total)}, под хосты ${num(p2p ? total : total - 2)}` },
      { k: "маска в битах", v: bin4(mask), html: `<code>${bin4(mask)}</code>` },
      { k: "в hex", v: `0x${net.toString(16).padStart(8, "0")}` },
    ];
    if (a4 !== net) rows.unshift({ k: "введено", v: `${m[1]}, это хост внутри сети` });
    const split = len < 32 ? [`${ip4(net)}/${len + 1}`, `${ip4((net + 2 ** (31 - len)) >>> 0)}/${len + 1}`] : [];
    const pm = len - 1 === 0 ? 0 : (~0 << (33 - len)) >>> 0;
    const parent = len > 0 ? `${ip4((net & pm) >>> 0)}/${len - 1}` : undefined;
    return { v: 4, cidr: `${ip4(net)}/${len}`, rows, split, parent, special: isSpecial(ip4(net)) };
  }
  const a6 = v6(m[1]);
  if (a6 === null) return null;
  const len = m[2] === undefined ? 128 : Number(m[2]);
  if (len > 128) return null;
  const host = 128n - BigInt(len);
  const mask = ((1n << 128n) - 1n) ^ ((1n << host) - 1n);
  const net = a6 & mask;
  const last = net | ((1n << host) - 1n);
  const total = 1n << host;
  const rows: Row[] = [
    { k: "сеть", v: `${ip6(net)}/${len}` },
    { k: "диапазон", v: `${ip6(net)} — ${ip6(last)}` },
    { k: "адресов", v: host <= 64n ? `2^${host} = ${total.toLocaleString("ru-RU")}` : `2^${host}` },
    { k: "подсетей /64", v: len <= 64 ? `2^${64 - len}${len >= 44 ? ` = ${num(2 ** (64 - len))}` : ""}` : "меньше одной /64: SLAAC не взлетит" },
  ];
  if (a6 !== net) rows.unshift({ k: "введено", v: `${ip6(a6)}, это адрес внутри сети` });
  const split = len < 128 ? [`${ip6(net)}/${len + 1}`, `${ip6(net | (1n << (host - 1n)))}/${len + 1}`] : [];
  const parent = len > 0 ? `${ip6(net & (mask << 1n) & ((1n << 128n) - 1n))}/${len - 1}` : undefined;
  return { v: 6, cidr: `${ip6(net)}/${len}`, rows, split, parent, special: isSpecial(ip6(net)) };
}

export async function calcPage(env: Env, req: Request, url: URL, mode: Mode, input: string) {
  const c = calc(input);
  const form = `<form class="bigsearch" action="/calc" method="get"><label class="vh" for="cq">Подсеть</label><input id="cq" name="q" value="${h(c?.cidr ?? input)}" placeholder="10.0.0.0/22 или 2001:db8::/48" autocomplete="off" spellcheck="false" style="font-family:var(--mono)"><button type="submit">Посчитать</button></form>`;
  if (!input) {
    return page(env, req, { title: "Калькулятор подсетей", nav: "/tools/" }, wrap(`<h1 class="hero-ip">calc</h1><p class="lede">Калькулятор подсетей IPv4 и IPv6. Маска, broadcast, диапазон хостов, деление пополам. Всё считается на месте, без запросов наружу.</p>${form}<ul class="try" style="margin-top:1rem"><li>Например:</li><li>${link("/calc/192.168.1.77/26", "192.168.1.77/26")}</li><li>${link("/calc/10.0.0.0/22", "10.0.0.0/22")}</li><li>${link("/calc/2001:db8::/48", "2001:db8::/48")}</li></ul>`, "52rem"));
  }
  if (!c) {
    const msg = `«${input}» не похоже на адрес или подсеть. Пример: 10.0.0.0/22`;
    if (mode !== "html") return mode === "json" ? json({ error: msg }, 400) : text(msg, 400);
    return page(env, req, { title: "Калькулятор подсетей", status: 400 }, wrap(`<h1 class="hero-ip">calc</h1><div class="callout callout-warning"><p class="callout-t">Не разобрал</p><p>${h(msg)}</p></div>${form}`, "52rem"));
  }
  if (mode === "json") return json({ cidr: c.cidr, version: c.v, private: c.special, ...Object.fromEntries(c.rows.map((r) => [r.k, r.v])), split: c.split, parent: c.parent });
  if (mode === "text") return text([c.cidr, ...c.rows.map((r) => `  ${r.k.padEnd(14)} ${r.v}`), c.split.length ? `  пополам        ${c.split.join("  ")}` : ""].join("\n"));
  const kv = `<dl class="kv">${c.rows.map((r) => `<dt>${h(r.k)}</dt><dd>${r.html ?? h(r.v)}</dd>`).join("")}</dl>`;
  const nav = `<nav class="quick">${c.parent ? link(`/calc/${c.parent}`, `↑ ${c.parent}`) : ""}${c.split.map((s) => link(`/calc/${s}`, s)).join("")}</nav>`;
  return page(env, req, { title: `calc ${c.cidr}`, nav: "/tools/", q: c.cidr, slot: "subnets" }, wrap(
    `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">${h(c.cidr)}</h1><p class="lede">IPv${c.v}${c.special ? ", частный или служебный диапазон" : `, публичный. ${link(`/${c.cidr}`, "Кто его анонсирует")}`}.</p>` +
    form + `<div style="height:1.25rem"></div>` + nav +
    `<div class="report"><section class="card is-up"><h2><span class="st st-up"></span>Подсеть</h2>${kv}</section></div>` +
    `<p class="more">В терминале: <code>curl host.pink/calc/${h(c.cidr)}</code></p>`,
    "52rem",
  ));
}
