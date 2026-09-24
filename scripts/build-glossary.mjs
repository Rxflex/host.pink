// Подсветка терминов из data/glossary.json в готовом HTML (после hugo).
// Первое вхождение каждого термина внутри <article> превращается в
// <a class="gl" href="/slovar/#id" data-tip="…">, подсказка рисуется CSS-ом, без JS.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PUB = join(ROOT, "public");
const { terms } = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8"));

const MAX_PER_PAGE = 40;
// страницы, где подсветка не нужна: сам словарь, служебные шаблоны
const SKIP_PAGES = [/^slovar\//, /^_shell\//, /^_shot/, /^404\.html$/];
// внутри этих элементов не подсвечиваем (у всех закрывающий тег обязателен даже с keepEndTags=false)
const SKIP_TAGS = new Set(["a", "code", "pre", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6", "summary", "button", "label", "time", "script", "style", "svg", "textarea", "select", "figure", "nav"]);
const SKIP_CLASS = /(?:^|\s)(?:dg|dg-[\w-]+|crumbs|hfacts|hfor|quick|no-gl|chip|sp-[\w-]+|adslot[\w-]*|hst|pager|toc)(?:\s|$)/;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// одна регулярка на все термины: группа N = термин N
const big = new RegExp(`(?<![\\p{L}\\p{N}_/@.-])(?:${terms.map((t) => `(${t.re})`).join("|")})(?![\\p{L}\\p{N}_@]|\\.\\p{L})`, "gu");
for (const t of terms) new RegExp(t.re, "u"); // упадём сразу на кривом выражении

function linkify(text, used, budget) {
  let out = "";
  let last = 0;
  big.lastIndex = 0;
  let m;
  while ((m = big.exec(text)) && used.size < budget) {
    const i = m.findIndex((g, k) => k > 0 && g !== undefined) - 1;
    const t = terms[i];
    if (used.has(t.id)) continue;
    used.add(t.id);
    out += text.slice(last, m.index) + `<a class="gl" href="/slovar/#${t.id}" data-tip="${esc(t.short)}">${m[0]}</a>`;
    last = m.index + m[0].length;
  }
  return last ? out + text.slice(last) : text;
}

function processArticle(html, used) {
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  const skip = []; // стек {tag, depth}
  let out = "";
  for (const tok of tokens) {
    if (tok[0] === "<") {
      const m = /^<(\/?)([a-zA-Z][\w-]*)([^>]*)>$/.exec(tok);
      if (m) {
        const [, close, rawTag, attrs] = m;
        const tag = rawTag.toLowerCase();
        const top = skip[skip.length - 1];
        if (close) {
          if (top && top.tag === tag && --top.depth === 0) skip.pop();
        } else if (!VOID.has(tag)) {
          if (top) {
            if (top.tag === tag) top.depth++;
          } else {
            const cls = /\bclass=(?:"([^"]*)"|([^\s>]+))/.exec(attrs);
            if (SKIP_TAGS.has(tag) || (cls && SKIP_CLASS.test(cls[1] ?? cls[2]))) skip.push({ tag, depth: 1 });
          }
        }
      }
      out += tok;
    } else {
      out += skip.length || used.size >= MAX_PER_PAGE ? tok : linkify(tok, used, MAX_PER_PAGE);
    }
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (name.endsWith(".html")) files.push(p);
  }
  return files;
}

let pages = 0;
let links = 0;
for (const file of walk(PUB)) {
  const rel = relative(PUB, file).split(sep).join("/");
  if (SKIP_PAGES.some((r) => r.test(rel))) continue;
  const html = readFileSync(file, "utf8");
  const a = html.indexOf("<article");
  const b = html.lastIndexOf("</article>");
  if (a < 0 || b < a) continue;
  const used = new Set();
  const body = processArticle(html.slice(a, b), used);
  if (!used.size) continue;
  writeFileSync(file, html.slice(0, a) + body + html.slice(b));
  pages++;
  links += used.size;
}
console.log(`glossary: ${terms.length} терминов, ${links} подсказок на ${pages} страницах`);
