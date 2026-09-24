// Оболочка страниц из Hugo (/_shell/) + рендер секций в трёх режимах: HTML (стримом), текст, JSON
import { adSlot, type SlotId } from "./ads";
import { colorOk, paint, sponsorLine } from "./ansi";
import { errText, h, type Mode } from "./util";

let cached: { head: string; tail: string } | null = null;

async function shell(env: Env, origin: string) {
  if (cached) return cached;
  const r = await env.ASSETS.fetch(new Request(`${origin}/_shell/`));
  const html = await r.text();
  const [head, tail] = html.split("<hp-slot></hp-slot>");
  if (tail === undefined) throw new Error("В /_shell/ нет маркера hp-slot, пересобери сайт");
  cached = { head, tail };
  return cached;
}

export type PageOpts = { title: string; desc?: string; nav?: string; q?: string; headExtra?: string; status?: number; headers?: HeadersInit; slot?: SlotId };

async function headFor(env: Env, req: Request, o: PageOpts) {
  const s = await shell(env, new URL(req.url).origin);
  let head = s.head
    .replace("__TITLE__", h(`${o.title} — host.pink`))
    .replace("__DESC__", h(o.desc ?? "Сетевые тулзы host.pink: DNS, TCP-пинг, BGP, доступность из РФ."))
    .replace("<hp-head></hp-head>", o.headExtra ?? "");
  if (o.nav) head = head.replace(`href=${o.nav}>`, `href=${o.nav} aria-current=page>`);
  if (o.q) head = head.replace("id=mq name=q", `id=mq name=q value="${h(o.q)}"`);
  return { head, tail: s.tail };
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export async function page(env: Env, req: Request, o: PageOpts, body: string) {
  const { head, tail } = await headFor(env, req, o);
  if (o.slot) body = body.replace(/<\/div><\/div>$/, `${adSlot(o.slot)}</div></div>`);
  return new Response(head + body + tail, { status: o.status ?? 200, headers: { ...HTML_HEADERS, ...o.headers } });
}

export const wrap = (inner: string, width = "84rem") =>
  `<div class="wrap tool" style="padding-top:2.5rem;padding-bottom:1rem"><div class="article" style="max-width:${width}">${inner}</div></div>`;

export function text(body: string, status = 200) {
  return new Response(body.endsWith("\n") ? body : body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

// ---------- секции досье ----------
export type Row = { k: string; v: string; html?: string };
export type State = "up" | "slow" | "down" | "none";
export type Result = { state?: State; note?: string; rows?: Row[]; html?: string; text?: string[]; data?: unknown; skip?: boolean };
export type Section = { id: string; title: string; wide?: boolean; run: () => Promise<Result> };

const DOT: Record<State, string> = { up: "st-up", slow: "st-slow", down: "st-down", none: "st-none" };

function card(s: Section, r: Result, order: number) {
  const st = r.state ?? "none";
  const rows = r.rows?.length
    ? `<dl class="kv">${r.rows.map((x) => `<dt>${h(x.k)}</dt><dd>${x.html ?? h(x.v)}</dd>`).join("")}</dl>`
    : "";
  return `<section class="card is-${st}${s.wide ? " wide" : ""}" data-r="${s.id}" style="order:${order}" aria-labelledby="c-${s.id}"><h2 id="c-${s.id}"><span class="st ${DOT[st]}"></span>${h(s.title)}${r.note ? ` <small>${h(r.note)}</small>` : ""}</h2>${rows}${r.html ?? ""}</section>`;
}

async function runSafe(s: Section): Promise<Result> {
  try {
    return await s.run();
  } catch (e) {
    return { state: "none", note: "источник не ответил", rows: [{ k: "ошибка", v: errText(e) }], data: { error: errText(e) } };
  }
}

export async function report(env: Env, req: Request, mode: Mode, o: PageOpts & { hero: string; heroText: string; after?: string }, sections: Section[]) {
  if (mode !== "html") {
    const results = await Promise.all(sections.map(runSafe));
    if (mode === "json") {
      return json({ query: o.q, ...Object.fromEntries(sections.map((s, i) => [s.id, results[i].data ?? Object.fromEntries((results[i].rows ?? []).map((r) => [r.k, r.v]))])) });
    }
    const p = paint(colorOk(req, new URL(req.url)));
    const out = [p.on ? `\n ${p.pinkB(o.heroText.replace(/^# /, ""))}` : o.heroText, ""];
    sections.forEach((s, i) => {
      const r = results[i];
      if (r.skip) return;
      out.push(p.on ? ` ${p.dot(r.state)} ${p.bold(s.title)}${r.note ? ` ${p.dim(r.note)}` : ""}` : `## ${s.title}${r.note ? ` (${r.note})` : ""}`);
      if (r.text) out.push(...r.text);
      else for (const row of r.rows ?? []) out.push(p.on ? `   ${p.dim(row.k.padEnd(18))} ${row.v}` : `  ${row.k.padEnd(18)} ${row.v}`);
      out.push("");
    });
    out.push(sponsorLine(p, "curl-report"), "");
    if (p.on) out.push(p.dim("  ?json — то же в JSON, ?plain — без цветов. Всё остальное: curl host.pink"), "");
    return text(out.join("\n"));
  }

  const { head, tail } = await headFor(env, req, o);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const put = (s: string) => w.write(enc.encode(s));

  (async () => {
    // заглушки видны, пока не придёт настоящая карточка; прячем их чистым CSS через :has()
    const hide = sections.map((s) => `.report:has(>[data-r="${s.id}"])>[data-p="${s.id}"]`).join(",");
    await put(
      head +
        `<style>${hide}{display:none}</style>` +
        `<div class="wrap tool" style="padding-top:2.5rem"><div class="article" style="max-width:84rem">${o.hero}<div class="report">` +
        sections.map((s, i) => `<section class="card ph${s.wide ? " wide" : ""}" data-p="${s.id}" style="order:${i}" aria-hidden="true"><h2><span class="st st-none"></span>${h(s.title)} <small class="pending">${s.wide ? "строим по маршрутам RIPE RIS, это секунд десять" : "спрашиваем"}</small></h2></section>`).join(""),
    );
    await Promise.all(
      sections.map(async (s, i) => {
        const r = await runSafe(s);
        await put(r.skip ? `<i data-r="${s.id}" hidden></i>` : card(s, r, i));
      }),
    );
    await put(`</div>${o.after ?? ""}${o.slot ? adSlot(o.slot) : ""}</div></div>` + tail);
    await w.close();
  })().catch(async (e) => {
    await put(`<p class="callout callout-warning">Что-то сломалось: ${h(errText(e))}</p>` + tail).catch(() => {});
    await w.close().catch(() => {});
  });

  return new Response(readable, { headers: { ...HTML_HEADERS, "x-content-type-options": "nosniff" } });
}

export const link = (href: string, label: string) => `<a href="${h(href)}">${h(label)}</a>`;
export const ext = (href: string, label: string) => `<a href="${h(href)}" rel="noopener nofollow">${h(label)}</a>`;
export const code = (s: string) => `<code>${h(s)}</code>`;
