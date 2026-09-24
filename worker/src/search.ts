// Полнотекстовый поиск по базе: D1 + FTS5. Русскую морфологию изображаем усечением слова и префиксным поиском.
import { json, link, page, text } from "./shell";
import { h, type Mode } from "./util";

const STOP = new Set("и в во на с со по к ко о об от до за из у не ни а но да же ли что как это то так для при или бы вы мы он она они его её их мне меня как где когда почему зачем какой какая какие есть нет the a an of to in on for is are and or how what why".split(" "));

export function ftsQuery(q: string, any = false): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? [])
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .slice(0, 8);
  if (!words.length) return null;
  const terms = words.map((w) => {
    const stem = /[а-яё]/.test(w) && w.length > 5 ? w.slice(0, Math.max(4, w.length - 3)) : w;
    return `"${stem.replace(/"/g, "")}"*`;
  });
  return terms.join(any ? " OR " : " ");
}

export type Hit = { url: string; title: string; heading: string; s: string; body?: string };

export async function find(env: Env, q: string, limit = 20, withBody = false): Promise<Hit[]> {
  const cols = `url, title, heading, snippet(docs, 2, char(1), char(2), '…', 28) AS s${withBody ? ", body" : ""}`;
  const run = (m: string) =>
    env.DB.prepare(`SELECT ${cols} FROM docs WHERE docs MATCH ?1 ORDER BY bm25(docs, 8, 4, 1) LIMIT ?2`).bind(m, limit).all<Hit>().then((r) => r.results);
  const strict = ftsQuery(q);
  if (!strict) return [];
  let hits = await run(strict).catch(() => [] as Hit[]);
  if (hits.length < 3) {
    const loose = ftsQuery(q, true)!;
    const more = await run(loose).catch(() => [] as Hit[]);
    const seen = new Set(hits.map((x) => x.url));
    hits = [...hits, ...more.filter((x) => !seen.has(x.url))].slice(0, limit);
  }
  return hits;
}

const mark = (s: string) => h(s).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
const clean = (s: string) => s.replace(/[\u0001\u0002]/g, "");

export async function searchPage(env: Env, req: Request, url: URL, mode: Mode) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const hits = q ? await find(env, q, limit) : [];
  if (mode === "json") return json({ q, results: hits.map((x) => ({ ...x, s: clean(x.s) })) });
  if (mode === "text") return text(hits.length ? hits.map((x) => `${x.title}${x.heading ? ` › ${x.heading}` : ""}\n  https://host.pink${x.url}\n  ${clean(x.s).replace(/\s+/g, " ")}`).join("\n\n") : "Ничего не нашлось.");

  const form = `<form class="bigsearch" action="/search" method="get" role="search"><label class="vh" for="sq">Что ищем</label><input id="sq" name="q" value="${h(q)}" placeholder="например, xhttp selfsteal" autocomplete="off" ${q ? "" : "autofocus"} enterkeyhint="search"><button type="submit">Найти</button></form>`;
  let body: string;
  if (!q) {
    body = `<p class="lede">Ищем по базе знаний и гайдам. Слова можно не склонять правильно, мы и так поймём.</p>${form}`;
  } else if (!hits.length) {
    body = `${form}<section class="void" style="padding:2rem 0"><h2>По «${h(q)}» пусто</h2><p>Попробуй другие слова или короче. Или ${link(`/ask?q=${encodeURIComponent(q)}`, "спроси ИИ")}, он тоже роется в этой базе, но умеет в синонимы.</p></section>`;
  } else {
    body =
      form +
      `<p class="more" style="margin:.5rem 0 1.5rem">Нашлось ${hits.length}${hits.length === 20 ? "+" : ""}. Не то? ${link(`/ask?q=${encodeURIComponent(q)}`, "Спросить ИИ")}.</p>` +
      `<ol class="results">${hits
        .map((x) => `<li><a href="${h(x.url)}"><b>${h(x.title)}</b>${x.heading ? `<span> › ${h(x.heading)}</span>` : ""}</a><p>${mark(x.s)}</p><small>${h(x.url)}</small></li>`)
        .join("")}</ol>`;
  }
  return page(env, req, { title: q ? `Поиск: ${q}` : "Поиск", q }, `<div class="wrap tool" style="padding-top:2.5rem"><div class="article" style="max-width:52rem"><h1 style="margin-bottom:1rem">Поиск</h1>${body}</div></div>`);
}
