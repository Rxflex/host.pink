// CI-страж: в public/ не должно быть исполняемого JS, а страницы — укладываться в бюджет
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const PUB = new URL("../public/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const HTML_BUDGET = 30 * 1024; // gzip
const CSS_BUDGET = 14 * 1024;  // gzip; один файл на весь сайт, кэш immutable
const errors = [];
let pages = 0, biggest = { size: 0, file: "" };

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const rel = relative(PUB, p).replaceAll("\\", "/");
    if (rel.startsWith("_shot")) continue;
    if (/\.(m?js|wasm)$/.test(name)) errors.push(`${rel}: JS-файл в сборке`);
    if (name.endsWith(".html")) {
      pages++;
      const html = readFileSync(p, "utf8");
      // speculationrules — JSON-подсказка браузеру, не код
      for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
        if (!/type=["']?speculationrules/i.test(m[1])) errors.push(`${rel}: <script${m[1]}>`);
      }
      if (/\son[a-z]+=["']/i.test(html.replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/g, ""))) errors.push(`${rel}: inline-обработчик on*=`);
      if (/href=["']?javascript:/i.test(html)) errors.push(`${rel}: javascript: ссылка`);
      const gz = gzipSync(html).length;
      if (gz > biggest.size) biggest = { size: gz, file: rel };
      if (gz > HTML_BUDGET && !rel.startsWith("baza/")) errors.push(`${rel}: ${(gz / 1024).toFixed(1)} КБ gzip > бюджета`);
    }
    if (name.endsWith(".css")) {
      const gz = gzipSync(readFileSync(p)).length;
      if (gz > CSS_BUDGET) errors.push(`${rel}: CSS ${(gz / 1024).toFixed(1)} КБ gzip > бюджета`);
    }
  }
}
walk(PUB);

console.log(`check-nojs: ${pages} страниц, самая тяжёлая ${biggest.file} — ${(biggest.size / 1024).toFixed(1)} КБ gzip`);
if (errors.length) {
  console.error(errors.map((e) => "  ✗ " + e).join("\n"));
  process.exit(1);
}
console.log("check-nojs: ни строчки JS");
