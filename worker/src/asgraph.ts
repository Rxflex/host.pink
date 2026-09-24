// Карта связности AS: пути из RIPE RIS looking glass → граф «origin → транзиты → Tier 1» → SVG.
// Интерактив без JS: наведение подсвечивает связи через :has(), клик ведёт в досье AS, подсказки в <title>.
import { link, type Result, type Section } from "./shell";
import { h, ripe } from "./util";

// Сети, которые никому не платят за транзит и видят весь интернет через пиринг друг с другом
export const TIER1 = new Set([174, 701, 1299, 2914, 3257, 3320, 3356, 3491, 5511, 6453, 6461, 6762, 6830, 7018, 12956]);
const SHARDS = 512;

type Names = Map<number, [string, string]>;

const shardCache = new Map<number, Record<string, [string, string]>>();

export async function asNames(env: Env, origin: string, asns: number[]): Promise<Names> {
  const out: Names = new Map();
  const need = [...new Set(asns.map((a) => a % SHARDS))].filter((s) => !shardCache.has(s));
  await Promise.all(
    need.map(async (s) => {
      const r = await env.ASSETS.fetch(new Request(`${origin}/asn/${s}.json`));
      shardCache.set(s, r.ok ? ((await r.json()) as Record<string, [string, string]>) : {});
    }),
  );
  for (const a of asns) out.set(a, shardCache.get(a % SHARDS)?.[a] ?? [`AS${a}`, ""]);
  return out;
}

// ---------- граф ----------
type Edge = { from: number; to: number; w: number };
export type Graph = { origins: number[]; nodes: number[]; depth: Map<number, number>; edges: Edge[]; paths: number; direct: Map<number, number> };

export function buildGraph(rawPaths: string[], maxNodes = 30): Graph {
  const edgeW = new Map<string, number>();
  const nodeW = new Map<number, number>();
  const depth = new Map<number, number>();
  const origins = new Set<number>();
  const direct = new Map<number, number>();
  let used = 0;
  const all = rawPaths.map((raw) => {
    const hops = raw.split(" ").map(Number).filter((x) => Number.isInteger(x) && x > 0);
    return hops.filter((a, i) => a !== hops[i - 1]).reverse(); // без препендов, от origin к пиру
  });
  // Пути «пир → origin» без Tier 1 — это пиринг, а не транзит. Рисуем, как у bgp.tools, только дорогу до Tier 1,
  // а если её нет совсем (сеть живёт на пиринге и региональных транзитах) — первые четыре хопа.
  const toT1 = all.filter((p) => p.length > 1 && p.some((a) => TIER1.has(a) && a !== p[0]));
  const chosen = toT1.length ? toT1 : all.filter((p) => p.length > 1);
  for (const path of chosen) {
    let end = path.findIndex((a, i) => i > 0 && TIER1.has(a));
    end = end === -1 ? Math.min(path.length - 1, 4) : end;
    const chain = path.slice(0, end + 1);
    used++;
    origins.add(chain[0]);
    direct.set(chain[1], (direct.get(chain[1]) ?? 0) + 1);
    chain.forEach((a, i) => {
      nodeW.set(a, (nodeW.get(a) ?? 0) + 1);
      depth.set(a, Math.min(depth.get(a) ?? 99, i));
      if (i) {
        const k = `${chain[i - 1]}>${a}`;
        edgeW.set(k, (edgeW.get(k) ?? 0) + 1);
      }
    });
  }
  // оставляем origin, все Tier 1 и самые нагруженные транзиты
  const keep = new Set<number>([...origins]);
  for (const a of nodeW.keys()) if (TIER1.has(a)) keep.add(a);
  [...nodeW].filter(([a]) => !keep.has(a)).sort((x, y) => y[1] - x[1]).slice(0, Math.max(0, maxNodes - keep.size)).forEach(([a]) => keep.add(a));
  const edges = [...edgeW]
    .map(([k, w]) => {
      const [from, to] = k.split(">").map(Number);
      return { from, to, w };
    })
    .filter((e) => keep.has(e.from) && keep.has(e.to) && !(TIER1.has(e.from) && TIER1.has(e.to)));
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = [...keep].filter((a) => origins.has(a) || linked.has(a));
  return { origins: [...origins], nodes, depth, edges, paths: used, direct };
}

// ---------- раскладка и SVG ----------
// Сверху вниз: origin → транзиты → Tier 1. Слои — горизонтальные полосы с подписями слева,
// так граф ложится на широкий экран, а не вытягивается в башню.
const NW = 140, NH = 58, HG = 14, LG = 92, GUT = 150, PADX = 16, TOP = 22, BOT = 22;

export function renderSvg(g: Graph, names: Names): string {
  const isT1 = (a: number) => TIER1.has(a);
  const isOg = (a: number) => g.origins.includes(a);
  // транзиты глубже двух хопов прижимаем ко второму слою: иначе граф уезжает вниз ради редких путей
  const maxMid = Math.min(2, Math.max(0, ...g.nodes.filter((a) => !isT1(a) && !isOg(a)).map((a) => g.depth.get(a) ?? 1)));
  const layerOf = (a: number) => (isOg(a) ? 0 : isT1(a) ? maxMid + 1 : Math.min(maxMid, Math.max(1, g.depth.get(a) ?? 1)));
  const layers: number[][] = Array.from({ length: maxMid + 2 }, () => []);
  for (const a of g.nodes) layers[layerOf(a)].push(a);
  const nonEmpty = layers.map((l, i) => [l, i] as const).filter(([l]) => l.length);

  const weight = new Map<number, number>();
  for (const e of g.edges) weight.set(e.to, (weight.get(e.to) ?? 0) + e.w);

  const widest = Math.max(...layers.map((l) => l.length), 1);
  const inner = widest * NW + (widest - 1) * HG;
  const width = GUT + inner + PADX;
  const cx = (i: number, n: number) => GUT + (inner - (n * NW + (n - 1) * HG)) / 2 + i * (NW + HG);

  // порядок в слое: барицентр родителей сверху, чтобы линии меньше путались
  const xmid = new Map<number, number>();
  const xy = new Map<number, [number, number]>();
  let y = TOP;
  const rowY = new Map<number, number>();
  for (const [layer, li] of nonEmpty) {
    if (li === 0) layer.sort((a, b) => a - b);
    else {
      const bary = (a: number) => {
        const ins = g.edges.filter((e) => e.to === a && xmid.has(e.from));
        return ins.length ? ins.reduce((s, e) => s + xmid.get(e.from)! * e.w, 0) / ins.reduce((s, e) => s + e.w, 0) : 1e9;
      };
      layer.sort((a, b) => bary(a) - bary(b) || (weight.get(b) ?? 0) - (weight.get(a) ?? 0));
    }
    rowY.set(li, y);
    layer.forEach((a, i) => {
      const x = cx(i, layer.length);
      xy.set(a, [x, y]);
      xmid.set(a, x + NW / 2);
    });
    y += NH + LG;
  }
  const height = y - LG + BOT;
  const maxW = Math.max(...g.edges.map((e) => e.w), 1);

  const neighbours = new Map<number, Set<number>>();
  for (const e of g.edges) {
    (neighbours.get(e.from) ?? neighbours.set(e.from, new Set()).get(e.from)!).add(e.to);
    (neighbours.get(e.to) ?? neighbours.set(e.to, new Set()).get(e.to)!).add(e.from);
  }

  const bands = nonEmpty
    .map(([layer, li]) => {
      const kind = li === 0 ? "og" : layer.every(isT1) ? "t1" : "tr";
      const [title, sub] = kind === "og" ? ["Origin", "анонсирует префикс"] : kind === "t1" ? ["Tier 1", "без транзита"] : ["Транзит", li === 1 ? "прямые апстримы" : "дальше по цепочке"];
      const by = rowY.get(li)!;
      return `<rect class="band ${kind}" x="4" y="${by - 10}" width="${width - 8}" height="${NH + 20}" rx="10"/><text class="bl" x="18" y="${by + NH / 2 - 2}">${title}</text><text class="bs" x="18" y="${by + NH / 2 + 14}">${sub}</text>`;
    })
    .join("");

  const edges = [...g.edges]
    .sort((a, b) => a.w - b.w)
    .map((e) => {
      const [x1, y1] = xy.get(e.from)!, [x2, y2] = xy.get(e.to)!;
      const sx = x1 + NW / 2, sy = y1 + NH, tx = x2 + NW / 2, ty = y2 - 3;
      const dy = Math.max(30, (ty - sy) / 2);
      const share = (e.w / g.paths) * 100;
      return `<path class="e f${e.from} t${e.to}" d="M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}" style="stroke-width:${(1.2 + (e.w / maxW) * 5).toFixed(1)}" marker-end="url(#ah)"><title>AS${e.from} → AS${e.to}: ${share < 1 ? "<1" : Math.round(share)}% маршрутов</title></path>`;
    })
    .join("");

  const nodes = g.nodes
    .map((a) => {
      const [x, ny] = xy.get(a)!;
      const [short, full] = names.get(a) ?? [`AS${a}`, ""];
      const kind = isOg(a) ? "og" : isT1(a) ? "t1" : "tr";
      const nb = [...(neighbours.get(a) ?? [])].map((n) => `nb${n}`).join(" ");
      const d = g.direct.get(a) ?? 0;
      const role = kind === "og" ? "origin, анонсирует префикс" : kind === "t1" ? "Tier 1: транзит не покупает, видит весь интернет через пиринг" : d ? `транзит, прямой апстрим в ${Math.max(1, Math.round((d / g.paths) * 100))}% путей` : "транзит дальше по цепочке";
      return `<a href="/AS${a}" class="n ${kind} a${a} ${nb}"><title>AS${a} ${h(full)}\n${role}</title><rect x="${x}" y="${ny}" width="${NW}" height="${NH}" rx="10"/><text class="asn" x="${x + NW / 2}" y="${ny + 26}">AS${a}</text><text class="nm" x="${x + NW / 2}" y="${ny + 44}">${h(short)}</text></a>`;
    })
    .join("");

  const hover = g.nodes
    .map((a) => `.asg:has(.a${a}:is(:hover,:focus)) :is(.e:not(.f${a}):not(.t${a}),.n:not(.a${a}):not(.nb${a})){opacity:.12}.asg:has(.a${a}:is(:hover,:focus)) :is(.f${a},.t${a}){stroke:var(--dye);stroke-dasharray:7 5;animation:flow .9s linear infinite;opacity:1}`)
    .join("");

  return `<style>${hover}</style><div class="asg-wrap" tabindex="0" role="region" aria-label="Карта связности AS"><svg class="asg" viewBox="0 0 ${width} ${height}" style="width:min(100%,${width}px);min-width:min(${width}px,780px)" role="img" aria-label="Граф: origin сверху, транзитные сети, Tier 1 снизу">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ahp"/></marker></defs>
<g class="bands">${bands}</g><g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg></div>`;
}

// ---------- секция досье ----------
async function pathsFor(prefixes: string[]) {
  const lg = await Promise.all(prefixes.slice(0, 2).map((p) => ripe("looking-glass", { resource: p }, 1800, 12000).catch(() => null)));
  return lg.flatMap((d) => (d?.rrcs ?? []).flatMap((r: any) => (r.peers ?? []).map((p: any) => String(p.as_path ?? ""))));
}

export function graphSection(env: Env, req: Request, prefixes: () => Promise<string[]>): Section {
  return {
    id: "graph",
    title: "Карта связности",
    wide: true,
    run: async (): Promise<Result> => {
      const pfx = await prefixes();
      if (!pfx.length) return { state: "none", rows: [{ k: "BGP", v: "Нечего рисовать: префикс не анонсируется." }] };
      const raw = await pathsFor(pfx);
      if (!raw.length) return { state: "none", note: "RIPE RIS не ответил", rows: [{ k: "RIS", v: "Looking glass RIPE не вернул маршрутов. Попробуй через пару минут." }] };
      const g = buildGraph(raw);
      const ups = [...g.direct].sort((a, b) => b[1] - a[1]);
      const names = await asNames(env, new URL(req.url).origin, [...g.nodes, ...ups.slice(0, 12).map(([a]) => a)]);
      const t1 = g.nodes.filter((a) => TIER1.has(a));
      const pct = (n: number) => (n / g.paths < 0.01 ? "<1%" : `${Math.round((n / g.paths) * 100)}%`);
      const upList = ups.slice(0, 12).map(([a, n]) => `${link(`/AS${a}`, `AS${a}`)} ${h(names.get(a)?.[0] ?? "")}${TIER1.has(a) ? " <b>T1</b>" : ""} — ${pct(n)}`).join("<br>");
      const direct1 = ups.filter(([a]) => TIER1.has(a)).length;
      const text = [
        `  путей до Tier 1 у RIS-пиров: ${g.paths}, префиксы: ${pfx.slice(0, 2).join(", ")}`,
        `  прямые апстримы:`,
        ...ups.slice(0, 12).map(([a, n]) => `    AS${a} ${names.get(a)?.[0] ?? ""}${TIER1.has(a) ? " [Tier 1]" : ""}  ${pct(n)}`),
        `  Tier 1 в маршрутах: ${t1.map((a) => `AS${a} ${names.get(a)?.[0]}`).join(", ") || "нет"}`,
      ];
      const others = ups.length - direct1;
      const summary = direct1 >= 5
        ? `Подключён напрямую к ${direct1} из ${TIER1.size} Tier 1. Это уровень крупного контент-провайдера или магистрала.`
        : direct1
          ? `Напрямую к Tier 1: ${direct1}${others ? `, плюс ${others} транзитных провайдеров` : ""}. Нормальная связность для хостера среднего размера.`
          : ups.length > 1
          ? `Прямых Tier 1 нет: выходит в мир через ${ups.length} транзитных провайдеров. Для большинства хостеров это норма.`
          : `Один апстрим. Упадёт он — упадёт всё. Для продакшена так себе идея.`;
      return {
        state: "up",
        note: `${g.paths} маршрутов RIS, ${g.nodes.length} AS`,
        html:
          `<p class="asg-sum">${h(summary)} Наведи на AS, чтобы подсветить её связи, кликни, чтобы открыть досье. Толщина линии — доля маршрутов.</p>` +
          renderSvg(g, names) +
          `<div class="asg-foot"><div><b>Прямые апстримы</b><p class="ups">${upList || "нет данных"}</p></div>` +
          `<details class="asg-help"><summary>Что тут вообще нарисовано</summary>` +
          `<p><b>Origin</b> — сеть, которая анонсирует префикс в BGP. <b>Транзит</b> — провайдер, которому origin платит за доставку трафика во весь интернет. <b>Tier 1</b> — полтора десятка магистральных сетей (Lumen, Arelion, Cogent, NTT и компания), которые сами никому за транзит не платят: весь интернет они видят через бесплатный пиринг друг с другом. Многие маршруты доходят до кого-то из них, но не все: часть путей идёт через пиринг и региональные транзиты без Tier 1. На карте показаны только те пути, что доходят до Tier 1, или, если таких нет, первые четыре хопа.</p>` +
          `<p>Линии построены по реальным AS-путям, которые видят сотни BGP-пиров <a href="https://ris.ripe.net" rel="noopener">RIPE RIS</a> по всему миру: от origin до первой Tier 1 на пути. Чем больше апстримов и чем толще связи с разными Tier 1, тем устойчивее сеть к падению одного провайдера. Российские сети часто выходят в мир через Ростелеком, ТТК, RETN или МегаФон, а не напрямую к Tier 1.</p></details></div>`,
        text,
        data: { prefixes: pfx, paths: g.paths, upstreams: Object.fromEntries(ups.map(([a, n]) => [a, n])), tier1: t1, edges: g.edges },
      };
    },
  };
}

