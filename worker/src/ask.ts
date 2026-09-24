// ИИ по базе: FTS5 находит фрагменты, Workers AI отвечает, ответ стримится HTML-ом без единой строчки JS
import { find, type Hit } from "./search";
import { json, link, page, text } from "./shell";
import { errText, h, type Mode } from "./util";

const DEEPWIKI = "https://deepwiki.com/Rxflex/BedolagaBD";

const SYSTEM = `Ты помощник сайта host.pink для сисадминов и сетевиков. Отвечай по-русски, коротко и по делу.
Опирайся только на фрагменты базы знаний из сообщения пользователя. Если ответа в них нет, прямо скажи «в базе этого нет» и подскажи, где искать.
Не выдумывай версии, команды, конфиги, цены и даты. Команды и конфиги давай в блоках \`\`\`.
После каждого утверждения ставь номер источника в квадратных скобках: [1], [2].
Рецепты обхода блокировок устаревают за 1–3 месяца: если во фрагменте есть дата, упомяни её.
Тон сухой, лёгкая ирония допустима, мата нет. Без вступлений вроде «Отличный вопрос».`;

const EXAMPLES = ["Почему отвалился XHTTP и чем заменить?", "Как включить BBR на ноде?", "Какой хостер выбрать под мост RU→EU?", "Что делает REMNAWAVE_AUTH_TYPE?"];

// ---------- маленький markdown построчно: ответ приходит кусками, рендерим каждую законченную строку ----------
type MdState = { fence: boolean; list: "" | "ul" | "ol" };

function inlineMd(s: string, sources: Hit[]) {
  return h(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[(\d{1,2})\]/g, (m, n) => {
      const src = sources[Number(n) - 1];
      return src ? `<a class="src" href="${h(src.url)}" title="${h(src.title)}">${n}</a>` : m;
    })
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" rel="noopener nofollow">$1</a>');
}

function mdLine(line: string, st: MdState, sources: Hit[]): string {
  let out = "";
  const closeList = () => {
    if (st.list) out += `</${st.list}>`;
    st.list = "";
  };
  if (line.trimStart().startsWith("```")) {
    if (st.fence) {
      st.fence = false;
      return "</code></pre>";
    }
    closeList();
    st.fence = true;
    return out + "<pre><code>";
  }
  if (st.fence) return h(line) + "\n";
  const li = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
  if (li) {
    const kind = li[1] ? "ul" : "ol";
    if (st.list !== kind) {
      closeList();
      out += `<${kind}>`;
      st.list = kind;
    }
    return out + `<li>${inlineMd(li[3], sources)}</li>`;
  }
  closeList();
  if (!line.trim()) return out;
  const hd = line.match(/^#{1,4}\s+(.*)$/);
  if (hd) return out + `<h3>${inlineMd(hd[1], sources)}</h3>`;
  return out + `<p>${inlineMd(line, sources)}</p>`;
}

function finish(st: MdState) {
  return (st.fence ? "</code></pre>" : "") + (st.list ? `</${st.list}>` : "");
}

const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();

async function cacheKey(q: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm(q)));
  return `https://cache.host.pink/ask/v2/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function sourcesHtml(hits: Hit[]) {
  if (!hits.length) return "";
  return `<h2 class="ask-h">Источники</h2><ol class="results sources">${hits.map((x) => `<li><a href="${h(x.url)}"><b>${h(x.title)}</b>${x.heading ? `<span> › ${h(x.heading)}</span>` : ""}</a></li>`).join("")}</ol>`;
}

const tired = (q: string) =>
  `<div class="callout callout-warning"><p class="callout-t">Нейроны кончились</p><p>Бесплатный лимит ИИ на сегодня выбран. Свои включай: ${link(`/search?q=${encodeURIComponent(q)}`, "поиск по базе")} работает всегда, а на <a href="${DEEPWIKI}" rel="noopener">DeepWiki</a> есть ИИ по той же базе.</p></div>`;

export async function askPage(env: Env, req: Request, url: URL, mode: Mode, ctx: ExecutionContext) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 400);
  const title = q ? `Вопрос: ${q.slice(0, 60)}` : "Спросить ИИ";
  const form = `<form class="bigsearch ask" action="/ask" method="get"><label class="vh" for="aq">Вопрос</label><textarea id="aq" name="q" rows="2" placeholder="Спроси как коллегу: что сломалось и что уже пробовал" ${q ? "" : "autofocus"} maxlength="400">${h(q)}</textarea><button type="submit">Спросить</button></form>`;

  if (!q) {
    return page(env, req, { title, nav: "/ask" }, `<div class="wrap tool" style="padding-top:2.5rem"><div class="article" style="max-width:52rem">
      <h1 style="margin-bottom:.75rem">Спросить ИИ</h1>
      <p class="lede">Отвечает по базе знаний со ссылками на источники. Не знает — так и скажет. Бесплатный, поэтому лимиты: пара вопросов в минуту с одного IP и общий дневной запас.</p>
      ${form}
      <ul class="try" style="margin-top:1.25rem"><li>Например:</li>${EXAMPLES.map((e) => `<li>${link(`/ask?q=${encodeURIComponent(e)}`, e)}</li>`).join("")}</ul>
      <p class="more">Нужен ответ без ИИ? ${link("/search", "Обычный поиск")}. Любишь альтернативы? <a href="${DEEPWIKI}" rel="noopener">DeepWiki</a> по той же базе.</p>
    </div></div>`);
  }

  const key = await cacheKey(q);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const cached = (await hit.json()) as { answer: string; html: string; hits: Hit[] };
    if (mode === "json") return json({ q, cached: true, answer: cached.answer, sources: cached.hits });
    if (mode === "text") return text(cached.answer + "\n\n" + cached.hits.map((x, i) => `[${i + 1}] https://host.pink${x.url}`).join("\n"));
    return page(env, req, { title, nav: "/ask", q }, shellTop(form, q) + `<div class="answer prose">${cached.html}</div>` + sourcesHtml(cached.hits) + shellBottom(true));
  }

  const { success } = await env.RL_AI.limit({ key: req.headers.get("cf-connecting-ip") ?? "anon" });
  if (!success) {
    const msg = "Не больше трёх вопросов в минуту. Подожди немного, ИИ тоже человек. Почти.";
    if (mode !== "html") return mode === "json" ? json({ error: msg }, 429) : text(msg, 429);
    return page(env, req, { title, nav: "/ask", q, status: 429 }, shellTop(form, q) + `<div class="callout callout-warning"><p class="callout-t">Помедленнее</p><p>${msg}</p></div>` + shellBottom(true));
  }

  const hits = (await find(env, q, 6, true)).slice(0, 6);
  const context = hits.length
    ? hits.map((x, i) => `[${i + 1}] ${x.title}${x.heading ? ` › ${x.heading}` : ""}\n${(x.body ?? "").slice(0, 1400)}`).join("\n\n")
    : "(по запросу ничего не нашлось)";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Фрагменты базы знаний:\n\n${context}\n\nВопрос: ${q}` },
  ];

  if (!env.AI) {
    const msg = "ИИ не подключён в этом окружении.";
    return mode === "html" ? page(env, req, { title, nav: "/ask", q }, shellTop(form, q) + tired(q) + sourcesHtml(hits) + shellBottom(true)) : text(msg, 503);
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = (await env.AI.run(env.AI_MODEL as any, { messages, stream: true, max_tokens: 900, temperature: 0.2 } as any)) as ReadableStream<Uint8Array>;
  } catch (e) {
    if (mode !== "html") return json({ error: errText(e), fallback: DEEPWIKI }, 503);
    return page(env, req, { title, nav: "/ask", q, status: 503 }, shellTop(form, q) + tired(q) + sourcesHtml(hits) + shellBottom(true));
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const put = (s: string) => w.write(enc.encode(s));
  const plainMode = mode !== "html";
  let head = "", tail = "";
  if (!plainMode) {
    const shell = await page(env, req, { title, nav: "/ask", q }, "<hp-split>");
    [head, tail] = (await shell.text()).split("<hp-split>");
  }

  ctx.waitUntil(
    (async () => {
      const st: MdState = { fence: false, list: "" };
      let answer = "", line = "", html = "";
      const emit = async (l: string) => {
        const frag = mdLine(l, st, hits);
        html += frag;
        if (!plainMode) await put(frag);
      };
      if (!plainMode) await put(head + shellTop(form, q) + `<p class="pending thinking" data-p="ai">Читаю базу и думаю</p><div class="answer prose">`);
      try {
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        let sse = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sse += value;
          const events = sse.split("\n");
          sse = events.pop() ?? "";
          for (const ev of events) {
            if (!ev.startsWith("data:")) continue;
            const data = ev.slice(5).trim();
            if (data === "[DONE]") continue;
            let tok = "";
            try {
              const j = JSON.parse(data);
              // числовые токены Workers AI отдаёт JSON-числом: 0 — не пустота, его нельзя терять
              const t = j.response ?? j.choices?.[0]?.delta?.content;
              if (t !== undefined && t !== null) tok = String(t);
            } catch {}
            if (tok === "") continue;
            answer += tok;
            if (plainMode) await put(tok);
            line += tok;
            const parts = line.split("\n");
            line = parts.pop() ?? "";
            for (const p of parts) await emit(p);
          }
        }
        if (line) await emit(line);
        const end = finish(st);
        html += end;
        if (plainMode) {
          await put("\n\n" + hits.map((x, i) => `[${i + 1}] https://host.pink${x.url}`).join("\n") + "\n");
        } else {
          await put(end + `</div><i data-r="ai" hidden></i>` + sourcesHtml(hits) + shellBottom(false) + tail);
        }
        if (answer.trim().length > 20) {
          await cache.put(key, new Response(JSON.stringify({ answer, html, hits }), { headers: { "cache-control": "public, max-age=86400", "content-type": "application/json" } }));
        }
      } catch (e) {
        if (!plainMode) await put(finish(st) + `</div><i data-r="ai" hidden></i>` + tired(q) + shellBottom(false) + tail).catch(() => {});
        else await put(`\n[ошибка: ${errText(e)}]\n`).catch(() => {});
      } finally {
        await w.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, {
    headers: plainMode ? { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } : { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const shellTop = (form: string, q: string) =>
  `<style>.article:has([data-r="ai"]) [data-p="ai"]{display:none}</style><div class="wrap tool" style="padding-top:2.5rem"><div class="article" style="max-width:52rem"><h1 class="ask-q">${h(q)}</h1>`;

const shellBottom = (withForm: boolean) =>
  `<p class="more">Ответ собран ИИ из фрагментов базы и может ошибаться. Проверяй по источникам, особенно даты. ${withForm ? "" : `${link("/ask", "Задать другой вопрос")} · `}Не помогло? <a href="${DEEPWIKI}" rel="noopener">DeepWiki</a> по той же базе.</p></div></div>`;
