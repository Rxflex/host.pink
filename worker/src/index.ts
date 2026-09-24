// host.pink: статика отдаётся сама, сюда приходит только то, чего нет в ассетах
import { colorOk, homeGuide, paint } from "./ansi";
import { askPage } from "./ask";
import { calcPage } from "./calc";
import { asnReport, hostReport, ipReport, prefixReport } from "./dossier";
import { classify, hrefOf, isSpecial } from "./net";
import { handleMcp, MCP_TOOLS } from "./mcp";
import { json, page, text, wrap } from "./shell";
import { searchPage } from "./search";
import { bad, checkResult, checkStart, dnsTool, myIp, pingTool } from "./tools";
import { errText, h, modeOf, type Mode } from "./util";

async function limited(env: Env, req: Request, mode: Mode) {
  const key = req.headers.get("cf-connecting-ip") ?? "anon";
  const { success } = await env.RL_TOOLS.limit({ key });
  if (success) return null;
  return bad(env, req, mode, "Помедленнее, ковбой", "Больше 30 проверок в минуту с одного IP не даём. Для мониторинга подними свой Uptime Kuma, это пять минут.", undefined, 429);
}

async function notFound(env: Env, req: Request, mode: Mode) {
  if (mode === "text") return text("404: нет такой страницы и такого хоста", 404);
  if (mode === "json") return json({ error: "not found" }, 404);
  const r = await env.ASSETS.fetch(new Request(new URL("/404.html", req.url)));
  return new Response(r.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const mode = modeOf(req, url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return notFound(env, req, mode);
  }
  // MCP для агентов: POST https://host.pink/mcp; в браузере по тому же адресу — инструкция
  if (path === "/mcp" || path === "/mcp/") {
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    const call = async (p: string, accept: string) => {
      const u = new URL(p, url);
      // статические markdown-копии статей и llms.txt отдаются из ассетов
      if (u.pathname.endsWith("/index.md") || u.pathname === "/llms.txt") return env.ASSETS.fetch(new Request(u));
      if (accept === "text/plain") u.searchParams.set("text", "");
      else u.searchParams.set("json", "");
      return route(new Request(u, { headers: { "cf-connecting-ip": ip, "user-agent": "host.pink-mcp/1.0", "x-hp-colo": String(req.cf?.colo ?? ""), accept } }), env, ctx);
    };
    return handleMcp(req, call, () => mcpPage(env, req));
  }

  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  // реестр плагинов hostpink: свежий с GitHub (кэш 5 минут на эдже), при сбое — копия из сборки.
  // Так правка в Rxflex/hostpink-registry доходит до клиентов без пересборки и деплоя сайта,
  // а пользователи из РФ, у которых GitHub режется, получают её через Cloudflare.
  if (path === "/plugins.json") {
    try {
      const r = await fetch("https://raw.githubusercontent.com/Rxflex/hostpink-registry/HEAD/hostpink-registry.json", {
        cf: { cacheTtl: 300, cacheEverything: true },
        headers: { "user-agent": "host.pink" },
      });
      if (r.ok) {
        const body = await r.text();
        JSON.parse(body); // битый JSON не отдаём
        return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "x-hp-registry": "github" } });
      }
    } catch {}
    const res = await env.ASSETS.fetch(new Request(new URL("/plugins.json", url)));
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "x-hp-registry": "mirror" } });
  }

  // установщик hostpink: curl | sh получает sh-скрипт, irm | iex — PowerShell, браузер — страницу про TUI
  if (path === "/tui" || path === "/tui.sh" || path === "/tui.ps1") {
    const ua = req.headers.get("user-agent") ?? "";
    const ps = path === "/tui.ps1" || (path === "/tui" && /PowerShell/i.test(ua));
    const sh = path === "/tui.sh" || (path === "/tui" && (mode === "text" || /^(curl|wget|fetch|busybox)/i.test(ua)));
    if (!ps && !sh) return Response.redirect(new URL("/tui/", url).toString(), 302);
    const res = await env.ASSETS.fetch(new Request(new URL(ps ? "/tui.ps1" : "/tui.sh", url)));
    return new Response(res.body, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  // браузер получает статическую главную, терминал — гайд с логотипом
  if (path === "/" || path === "/help") {
    if (mode === "text") return text(homeGuide(req, paint(colorOk(req, url))));
    if (mode === "json") return json({ docs: "https://host.pink/tools/", endpoints: ["/ip", "/{ip}", "/{domain}", "/AS{n}", "/{prefix}", "/dns/{name}", "/ping/{host}:{port}", "/check/{host}?t=http|ping|tcp|dns|mtr", "/search?q=", "/ask?q="] });
    const res = await env.ASSETS.fetch(new Request(new URL("/", url), req));
    if (!res.ok) return res;
    const cf = (req.cf ?? {}) as Record<string, any>;
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    const where = [cf.city, cf.country].filter(Boolean).join(", ");
    const here = `<span class="st st-up"></span>Ты: <a href="/${h(ip)}"><code>${h(ip)}</code></a> <span>${cf.asn ? `<a href="/AS${cf.asn}">AS${cf.asn}</a> ${h(cf.asOrganization ?? "")}` : ""}${where ? `, ${h(where)}` : ""}</span> <span>через Cloudflare <code>${h(cf.colo ?? "?")}</code></span>`;
    return new HTMLRewriter()
      .on("#here", { element: (e) => void e.setInnerContent(here, { html: true }) })
      .transform(new Response(res.body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }

  if (path === "/go") {
    const k = classify(url.searchParams.get("q") ?? "");
    return Response.redirect(new URL(k ? hrefOf(k) : "/", url).toString(), 303);
  }
  if (path === "/ip" || path === "/ip/") return myIp(env, req, url, mode);

  if (path === "/calc" || path === "/calc/") return calcPage(env, req, url, mode, url.searchParams.get("q") ?? "");
  if (path.startsWith("/calc/")) return calcPage(env, req, url, mode, path.slice(6).replace(/\/$/, ""));
  if (path === "/search") return searchPage(env, req, url, mode);
  if (path === "/ask") return askPage(env, req, url, mode, ctx);

  const tool = path.match(/^\/(dns|ping|check)\/(.+?)\/?$/);
  const seg = path.slice(1).replace(/\/$/, "");
  const k = tool ? null : classify(seg, false);
  if (!tool && !k) return notFound(env, req, mode);

  const slow = await limited(env, req, mode);
  if (slow) return slow;

  if (tool) {
    const [, name, arg] = tool;
    if (name === "dns") return dnsTool(env, req, url, mode, arg);
    if (name === "ping") return pingTool(env, req, url, mode, arg);
    const r = arg.match(/^r\/([A-Za-z0-9]+)$/);
    return r ? checkResult(env, req, url, mode, r[1]) : checkStart(env, req, url, mode, arg);
  }
  switch (k!.t) {
    case "ip": return ipReport(env, req, mode, k!.ip);
    // частные сети в BGP не живут — сразу в калькулятор
    case "prefix": return isSpecial(k!.p.split("/")[0]) ? Response.redirect(new URL(`/calc/${k!.p}`, url).toString(), 302) : prefixReport(env, req, mode, k!.p);
    case "asn":
      // канонический вид: /AS13335
      if (seg !== `AS${k!.n}`) return Response.redirect(new URL(`/AS${k!.n}${url.search}`, url).toString(), 301);
      return asnReport(env, req, mode, k!.n);
    case "host": return hostReport(env, req, mode, k!.host);
    default: return notFound(env, req, mode);
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      const url = new URL(req.url);
      return bad(env, req, modeOf(req, url), "Что-то упало", `${errText(e)}. Обнови страницу через минуту, а если не поможет — значит, упал источник данных, не мы. Наверное.`, undefined, 502);
    }
  },
} satisfies ExportedHandler<Env>;

async function mcpPage(env: Env, req: Request) {
  const tools = MCP_TOOLS.map((t) => `<li><code>${h(t.name)}</code> <b>${h(t.title)}</b><br><span>${h(t.description)}</span></li>`).join("");
  const code = (lang: string, name: string, body: string) =>
    `<div class="code"><div class="code-name"><span>${h(name)}</span><span>${lang}</span></div><pre><code>${h(body)}</code></pre></div>`;
  return page(env, req, { title: "MCP для агентов", nav: "/tools/", desc: "host.pink как MCP-сервер: досье IP, доменов и ASN, проверки из РФ, база знаний — прямо в Claude, Cursor и других агентах." }, wrap(
    `<p class="crumbs"><a href="/tools/">Тулзы</a></p><h1 class="hero-ip">host.pink/mcp</h1>` +
    `<p class="lede">MCP-сервер для ИИ-агентов. Подключаешь одну ссылку, и агент сам смотрит досье IP и доменов, проверяет доступность из России, читает базу знаний. Без ключей и регистрации.</p>` +
    `<div class="prose" style="max-width:var(--measure)">` +
    `<h2 id="podklyuchit">Подключить</h2>` +
    `<p>Адрес сервера: <code>https://host.pink/mcp</code>. Транспорт Streamable HTTP, ответы JSON, без сессий: работают и новые клиенты (MCP 2026-07-28), и старые (2025-03-26 и новее).</p>` +
    `<h3 id="claude-code">Claude Code</h3>` + code("bash", "терминал", "claude mcp add --transport http host-pink https://host.pink/mcp") +
    `<h3 id="claude-ai">Claude (claude.ai, десктоп)</h3><p>В настройках коннекторов добавь свой (custom) коннектор и укажи URL <code>https://host.pink/mcp</code>. Авторизация не нужна.</p>` +
    `<h3 id="cursor">Cursor, Windsurf и остальные</h3>` + code("json", "mcp.json", `{\n  "mcpServers": {\n    "host-pink": { "url": "https://host.pink/mcp" }\n  }\n}`) +
    `<h3 id="curl">Проверить руками</h3>` + code("bash", "терминал", `curl -s https://host.pink/mcp -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ip_lookup","arguments":{"ip":"8.8.8.8"}}}'`) +
    `<h2 id="tulzy">Тулзы</h2><ul class="mcp-tools">${tools}</ul>` +
    `<h2 id="limity">Лимиты</h2><p>Те же, что у сайта: 30 сетевых проверок в минуту с IP, 3 вопроса ИИ в минуту. Проверки из разных стран кешируются на две минуты. Для мониторинга раз в секунду это не подходит, для агента, который разбирается с проблемой, хватает с запасом.</p>` +
    `</div>`,
    "64rem",
  ));
}
