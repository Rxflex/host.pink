// BedolagaBD (vendor/bedolagabd) → Hugo-контент в .generated/content/baza
// Спека разделов берётся из _tools/kb_lib.py самого репо, чтобы не дублировать.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KB = join(ROOT, "vendor", "bedolagabd");
const OUT = join(ROOT, ".generated", "content", "baza");
const ASSETS_OUT = join(ROOT, ".generated", "static", "baza-assets");
const GH = "https://github.com/Rxflex/BedolagaBD/blob/main/";

if (!existsSync(join(KB, "_tools", "kb_lib.py"))) {
  console.error("Нет vendor/bedolagabd. Выполни: git submodule update --init");
  process.exit(1);
}

const py = process.platform === "win32" ? "python" : "python3";
const spec = JSON.parse(
  execFileSync(py, ["-c", "import sys,json; sys.path.insert(0,'_tools'); import kb_lib as k; print(json.dumps({'sections': k.SECTIONS, 'months': k.month_files()}, ensure_ascii=False))"], { cwd: KB, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
);

const TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const translit = (s) =>
  s.toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? c).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const SECTION_SLUG = { "01": "paneli", "02": "transporty", "03": "tspu", "04": "set", "05": "hosting", "06": "platezhki", "07": "skripty", "08": "hronologiya", "09": "indeksy" };

// repo-путь .md → URL на сайте
const urlOf = new Map();
const docs = [];

for (const s of spec.sections) {
  const secSlug = SECTION_SLUG[s.key];
  const files = s.key === "08" ? spec.months : s.files;
  urlOf.set(`${s.dir}/README.md`, `/baza/${secSlug}/`);
  files.forEach(([file, name, desc], i) => {
    const repoPath = `${s.dir}/${file}`;
    const slug = translit(file.replace(/\.md$/, ""));
    urlOf.set(repoPath, `/baza/${secSlug}/${slug}/`);
    docs.push({ section: s, secSlug, repoPath, slug, name, desc, weight: i + 1 });
  });
}

const INDEXES = [
  ["ошибки.md", "Ошибки → фиксы", "257 симптомов и куда смотреть за лечением"],
  ["релизы.md", "Релизы", "все версии Bedolaga, Cabinet и Remnawave по продуктам"],
  ["env.md", "Env-переменные", "какая переменная что делает и где описана"],
  ["термины.md", "Термины", "глоссарий: ТСПУ, БС, selfsteal и остальной сленг"],
  ["ссылки.md", "Ссылки", "все внешние ссылки базы в одном месте"],
];
const idxSection = { key: "09", name: "Индексы", blurb: "Сквозные указатели: ошибки, релизы, env, термины, ссылки", dir: "indexes" };
INDEXES.forEach(([file, name, desc], i) => {
  const repoPath = `indexes/${file}`;
  const slug = translit(file.replace(/\.md$/, ""));
  urlOf.set(repoPath, `/baza/indeksy/${slug}/`);
  docs.push({ section: idxSection, secSlug: "indeksy", repoPath, slug, name, desc, weight: i + 1 });
});
urlOf.set("README.md", "/baza/");
urlOf.set("MAP.md", "/baza/");
urlOf.set("docs/README.md", "/baza/");

const yamlStr = (v) => JSON.stringify(String(v));

function rewriteLink(target, fromRepoPath) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, hash] = target.split("#");
  const abs = posix.normalize(posix.join(posix.dirname(fromRepoPath), decodeURI(path)));
  const tail = hash ? `#${hash}` : "";
  if (urlOf.has(abs)) return urlOf.get(abs) + tail;
  if (abs.startsWith("assets/")) return `/baza-assets/${abs.slice(7)}`;
  return GH + encodeURI(abs) + tail;
}

function convert(md, repoPath) {
  let proofs = 0;
  md = md
    .replace(/<!-- KB:(\w+) -->[\s\S]*?<!-- \/KB:\1 -->\n?/g, "")
    .replace(/<!-- Сгенерировано[^>]*-->\n?/g, "")
    .replace(/^# .*\n/, "")
    .replace(/^(\[⌂|◀ \[).*\n/gm, "");

  // пруфы без ссылки: [note_055:190-195|30.03.2026] → ссылка на первоисточник
  md = md.replace(/\[(note_(\d{3})(?::(\d+)(?:-\d+)?)?[^\]]*)\](?!\()/g, (_, text, n, line) =>
    `[${text}](${GH}source/notes/note_${n}.md${line ? `#L${line}` : ""})`);

  // относительные ссылки и картинки
  md = md.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, url, b) => a + rewriteLink(url, repoPath) + b);
  md = md.replace(/(<img[^>]*\ssrc=")([^"]+)(")/g, (_, a, url, b) => a + rewriteLink(url, repoPath) + b);

  proofs = (md.match(/\[id=/g) || []).length;
  return { md: md.trim() + "\n", proofs };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

writeFileSync(join(OUT, "_index.md"), `---
title: "База знаний"
lede: "Год жизни сообщества Bedolaga Social Club в одном справочнике: 788 000 сообщений, 108 документов, у каждого факта пруф на сообщение в чате. Конфиги и команды дословные."
weight: 1
---
Источник — [BedolagaBD](https://github.com/Rxflex/BedolagaBD), лицензия CC BY-SA 4.0. Период 23.08.2025 — 23.08.2026. Рецепты обхода блокировок живут 1–3 месяца, поэтому смотри на дату пруфа, прежде чем копировать конфиг в прод.

> [!TIP]
> Пилюля с датой рядом с фактом — ссылка на исходное сообщение в Telegram-чате. Откроется, только если ты в чате.
`);

const sectionsSeen = new Set();
for (const d of docs) {
  const secDir = join(OUT, d.secSlug);
  if (!sectionsSeen.has(d.secSlug)) {
    sectionsSeen.add(d.secSlug);
    mkdirSync(secDir, { recursive: true });
    writeFileSync(join(secDir, "_index.md"), `---
title: ${yamlStr(d.section.name)}
key: ${yamlStr(d.section.key)}
lede: ${yamlStr(d.section.blurb)}
weight: ${Number(d.section.key)}
---
`);
  }
  const src = readFileSync(join(KB, d.repoPath), "utf8").replace(/\r\n/g, "\n");
  const { md, proofs } = convert(src, d.repoPath);
  const lastmod = gitDate(d.repoPath);
  writeFileSync(join(secDir, `${d.slug}.md`), `---
title: ${yamlStr(d.name)}
lede: ${yamlStr(d.desc ? d.desc[0].toUpperCase() + d.desc.slice(1) + "." : "")}
weight: ${d.weight}
proofs: ${proofs || '""'}
source: ${yamlStr(GH + d.repoPath)}
${lastmod ? `lastmod: ${lastmod}\n` : ""}---
${md}`);
}

function gitDate(p) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", p], { cwd: KB, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

rmSync(ASSETS_OUT, { recursive: true, force: true });
cpSync(join(KB, "assets"), ASSETS_OUT, { recursive: true });

console.log(`import: ${docs.length} документов, ${sectionsSeen.size} разделов → ${relative(ROOT, OUT)}`);
