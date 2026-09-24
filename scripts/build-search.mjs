// Markdown-контент → чанки по заголовкам → SQL для D1 (FTS5). Один индекс и для /search, и для ИИ.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shortcodesToMarkdown } from "./shortcodes-md.mjs";
import { hosterPlain, loadHosters } from "./hosters.mjs";
import { loadPayments, paymentPlain } from "./payments.mjs";
import { loadProtection, protectionPlain } from "./protection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [join(ROOT, ".generated", "content"), join(ROOT, "content")];
const OUT = join(ROOT, ".generated", "search.sql");
const MAX = 1600;

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (n.endsWith(".md") && !n.startsWith("_")) yield p;
  }
}

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return [{}, src];
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2];
  }
  return [fm, src.slice(m[0].length)];
}

const inline = (s) =>
  s
    .replace(/\[(?:id=|note_)[^\]]*\]\([^)]*\)/g, "") // пруфы — шум для поиска
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/g, " ")
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1")
    .replace(/`([^`]*)`/g, "$1");

// как Hugo autoHeadingIDType = "github"
function slugger() {
  const used = new Map();
  return (text) => {
    const t = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/g, "").replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1").replace(/`([^`]*)`/g, "$1");
    let s = t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
    const n = used.get(s) ?? 0;
    used.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  };
}

const plain = (md) =>
  inline(md)
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s?(\[!\w+\])?/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

function urlOf(file, base, fm) {
  if (fm.url) return fm.url;
  const rel = relative(base, file).replaceAll("\\", "/").replace(/\.md$/, "");
  return `/${rel}/`;
}

const rows = [];
for (const base of SOURCES) {
  for (const file of walk(base)) {
    const [fm, raw] = frontMatter(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    const body = shortcodesToMarkdown(raw);
    if (!fm.title || fm.layout === "shell" || fm.layout === "kit" || fm.url === "/_kit/") continue;
    const url = urlOf(file, base, fm);
    const slug = slugger();
    let heading = "", anchor = "", buf = [], inFence = false;
    const flush = () => {
      const text = plain(buf.join("\n"));
      buf = [];
      // списки ссылок на документацию — не ответ на вопрос, в поиск не берём
      if (text.length < 40 || /^источники$/i.test(heading)) return;
      for (let i = 0; i < text.length; i += MAX) rows.push({ url: url + (anchor ? `#${anchor}` : ""), title: fm.title, heading, body: text.slice(i, i + MAX) });
    };
    if (fm.lede) buf.push(fm.lede);
    for (const line of body.split("\n")) {
      if (line.startsWith("```")) inFence = !inFence;
      const hm = !inFence && line.match(/^(#{2,3})\s+(.+)$/);
      if (hm) {
        flush();
        heading = plain(hm[2]);
        anchor = slug(hm[2]);
        continue;
      }
      buf.push(line);
    }
    flush();
  }
}

// карточки хостеров: одна запись на хостера (длинные — кусками)
for (const h of loadHosters(ROOT)) {
  const text = hosterPlain(h);
  for (let i = 0; i < text.length; i += MAX) rows.push({ url: `/hostery/${h.id}/`, title: `${h.name} — хостер`, heading: "", body: text.slice(i, i + MAX) });
}

// карточки платёжек
for (const p of loadPayments(ROOT)) {
  const text = paymentPlain(p);
  for (let i = 0; i < text.length; i += MAX) rows.push({ url: `/platezhki/${p.id}/`, title: `${p.name} — платёжка`, heading: "", body: text.slice(i, i + MAX) });
}

// карточки защиты от DDoS
for (const p of loadProtection(ROOT)) {
  const text = protectionPlain(p);
  for (let i = 0; i < text.length; i += MAX) rows.push({ url: `/zashchita/${p.id}/`, title: `${p.name} — защита от DDoS`, heading: "", body: text.slice(i, i + MAX) });
}

// словарь: одна запись на термин
const glossary = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8"));
for (const t of glossary.terms) {
  const body = [t.also, t.short, t.body?.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")].filter(Boolean).join("\n");
  rows.push({ url: `/slovar/#${t.id}`, title: `${t.term} — словарь`, heading: "", body: body.slice(0, MAX) });
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = [
  "DROP TABLE IF EXISTS docs;",
  "CREATE VIRTUAL TABLE docs USING fts5(title, heading, body, url UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');",
  ...rows.map((r) => `INSERT INTO docs (title, heading, body, url) VALUES (${q(r.title)}, ${q(r.heading)}, ${q(r.body)}, ${q(r.url)});`),
].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, sql);
console.log(`search: ${rows.length} чанков, ${(sql.length / 1024 / 1024).toFixed(1)} МБ SQL → ${relative(ROOT, OUT)}`);
