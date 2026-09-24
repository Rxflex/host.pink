// Для ИИ-агентов: /llms.txt (карта сайта и API), /llms-full.txt (вся база одним файлом)
// и markdown-копия каждой статьи рядом с HTML: /baza/…/index.md
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shortcodesToMarkdown } from "./shortcodes-md.mjs";
import { hosterMarkdown, loadHosters } from "./hosters.mjs";
import { KIND, STATE as PSTATE, loadPayments, paymentMarkdown } from "./payments.mjs";
import { PKIND, PSTATE as ZSTATE, loadProtection, protectionMarkdown } from "./protection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(ROOT, "public");
const SITE = "https://host.pink";
const SOURCES = [join(ROOT, ".generated", "content"), join(ROOT, "content")];

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return [{}, src];
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2].trim();
  }
  return [fm, src.slice(m[0].length)];
}

function* walk(dir) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (n.endsWith(".md")) yield p;
  }
}

const sections = new Map(); // url раздела → { title, lede, weight, pages: [] }
const pages = [];
for (const base of SOURCES) {
  for (const file of walk(base)) {
    const [fm, body] = frontMatter(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    const rel = relative(base, file).replaceAll("\\", "/");
    if (fm.layout === "shell" || fm.layout === "kit" || rel === "_index.md") continue;
    if (rel.endsWith("_index.md")) {
      const url = `/${rel.replace(/_index\.md$/, "")}`;
      sections.set(url, { title: fm.title, lede: fm.lede, weight: Number(fm.weight ?? 99), pages: [] });
      continue;
    }
    const url = fm.url ?? `/${rel.replace(/\.md$/, "")}/`;
    pages.push({ url, title: fm.title, lede: fm.lede ?? "", weight: Number(fm.weight ?? 99), category: fm.category, body: shortcodesToMarkdown(body).trim(), source: fm.source });
  }
}
for (const p of pages) {
  const sec = [...sections.keys()].filter((s) => p.url.startsWith(s)).sort((a, b) => b.length - a.length)[0];
  if (sec) sections.get(sec).pages.push(p);
}

// markdown-копии рядом с HTML
for (const p of pages) {
  const dir = join(PUB, p.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), `# ${p.title}\n\n${p.lede ? `> ${p.lede}\n\n` : ""}${p.body}\n\n---\nИсточник: ${SITE}${p.url}${p.source ? `\nОригинал: ${p.source}` : ""}\nЛицензия: CC BY-SA 4.0\n`);
}

const guideCats = JSON.parse(readFileSync(join(ROOT, "data", "guide_categories.json"), "utf8"));
const line = (p) => `- [${p.title}](${SITE}${p.url}index.md)${p.lede ? `: ${p.lede}` : ""}`;
// карточки хостеров: markdown-копии и блок в llms.txt
const hosters = loadHosters(ROOT);
for (const h of hosters) {
  const dir = join(PUB, "hostery", h.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), hosterMarkdown(h, SITE) + `\n\n---\nИсточник: ${SITE}/hostery/${h.id}/\nЛицензия: CC BY-SA 4.0\n`);
}
const HSTATE = { ok: "работает из РФ", partial: "частично из РФ", blocked: "в блоке из РФ", unknown: "нет данных" };
const hosterBlock = hosters.length
  ? ["## Хостеры (каталог)", "", "Сводные карточки по хостерам из опыта сообщества: доступность из РФ, цены, для чего брать, хронология с датами и пруфами.", "", ...hosters.map((h) => `- [${h.name}](${SITE}/hostery/${h.id}/index.md): ${h.group === "ru" ? "РФ" : "зарубежный"}, ${HSTATE[h.ru_access?.state] ?? HSTATE.unknown}${h.ru_access?.date ? ` (${h.ru_access.date})` : ""}`), ""]
  : [];

// карточки платёжек
const payments = loadPayments(ROOT);
for (const p of payments) {
  const dir = join(PUB, "platezhki", p.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), paymentMarkdown(p) + `

---
Источник: ${SITE}/platezhki/${p.id}/
Лицензия: CC BY-SA 4.0
`);
}
const paymentBlock = payments.length
  ? ["## Платёжки (каталог)", "", "Сводные карточки по платёжным провайдерам из опыта сообщества: тип (белая, серая, крипта, Telegram), статус, комиссии, требования, интеграция с Bedolaga, хронология с датами и пруфами.", "", ...payments.map((p) => `- [${p.name}](${SITE}/platezhki/${p.id}/index.md): ${KIND[p.kind] ?? "—"}, ${PSTATE[p.status?.state] ?? PSTATE.unknown}${p.status?.date ? ` (${p.status.date})` : ""}`), ""]
  : [];

// карточки защиты от DDoS
const protection = loadProtection(ROOT);
for (const p of protection) {
  const dir = join(PUB, "zashchita", p.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), protectionMarkdown(p) + "\n\n---\nИсточник: " + SITE + "/zashchita/" + p.id + "/\nЛицензия: CC BY-SA 4.0\n");
}
const protectionBlock = protection.length
  ? ["## Защита от DDoS (каталог)", "", "Анти-DDoS сервисы по опыту сообщества: открывается ли защищённое из РФ, уровни L3/L4/L7, для чего ставят, цены и хронология с пруфами.", "", ...protection.map((p) => `- [${p.name}](${SITE}/zashchita/${p.id}/index.md): ${PKIND[p.kind] ?? "—"}, ${ZSTATE[p.ru_access?.state] ?? ZSTATE.unknown}${p.ru_access?.date ? ` (${p.ru_access.date})` : ""}${p.sponsor ? ", спонсор host.pink" : ""}`), ""]
  : [];

// словарь терминов
const glossary = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8"));
const glossaryMd = [
  "# Словарь host.pink",
  "",
  "> Сленг и сложные термины из базы и чата сообщества простым языком.",
  "",
  ...glossary.cats.flatMap((c) => [
    `## ${c.title}`,
    "",
    ...glossary.terms.filter((t) => t.cat === c.id).map((t) => `### ${t.term}${t.also ? ` (${t.also})` : ""}

${(t.body || t.short).replace(/\]\(\//g, `](${SITE}/`)}${t.link ? `

Подробнее: ${SITE}${t.link}` : ""}
`),
  ]),
].join("\n");
mkdirSync(join(PUB, "slovar"), { recursive: true });
writeFileSync(join(PUB, "slovar", "index.md"), glossaryMd + `

---
Источник: ${SITE}/slovar/
Лицензия: CC BY-SA 4.0
`);

// газета «Розовый вестник»: markdown-копии выпусков
const GZ = join(ROOT, "data", "gazeta");
const issues = existsSync(GZ)
  ? readdirSync(GZ).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => JSON.parse(readFileSync(join(GZ, f), "utf8"))).sort((a, b) => b.issue - a.issue)
  : [];
const pf = (x) => (x.proof ? ` ([пруф](${x.proof}))` : "");
const gazetaMd = (g) => [
  `# Розовый вестник №${g.issue} — ${g.title}`,
  "",
  `> Газета-дайджест хронологии сообщества за месяц. Все события без сокращений: ${SITE}/baza/hronologiya/${g.month}/`,
  "",
  g.weather ? `Погода в ТСПУ: ${g.weather}\n` : "",
  `## ${g.lead.headline}`,
  "",
  `*${g.lead.dek}*`,
  "",
  ...g.lead.body.map((p) => `${p}\n`),
  g.lead.proofs?.length ? `Пруфы: ${g.lead.proofs.map((p) => `[${p.label}](${p.url})`).join(", ")}\n` : "",
  ...(g.stories ?? []).map((s) => `### ${s.rubric}: ${s.headline}\n\n${s.text} (${s.date}${pf(s)})\n`),
  g.numbers?.length ? `## Цифры месяца\n\n${g.numbers.map((n) => `- **${n.value}** — ${n.label} (${n.date}${pf(n)})`).join("\n")}\n` : "",
  g.quote ? `## Цитата месяца\n\n> ${g.quote.text}\n\n— ${g.quote.who}, ${g.quote.date}${pf(g.quote)}\n` : "",
  g.releases?.length ? `## Релизы\n\n${g.releases.map((r) => `- **${r.name}** ${r.note ?? ""} (${r.date}${pf(r)})`).join("\n")}\n` : "",
  g.brief?.length ? `## Коротко\n\n${g.brief.map((b) => `- ${b.date}: ${b.text}${pf(b)}`).join("\n")}\n` : "",
  g.archive?.length ? `## Из архива\n\n${g.archive.map((b) => `- ${b.date}: ${b.text}${pf(b)}`).join("\n")}\n` : "",
].filter((l) => l !== "").join("\n");
for (const g of issues) {
  const dir = join(PUB, "gazeta", g.month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), gazetaMd(g) + `\n\n---\nИсточник: ${SITE}/gazeta/${g.month}/\nЛицензия: CC BY-SA 4.0\n`);
}
const gazetaBlock = issues.length
  ? ["## Розовый вестник (газета)", "", "Хронология сообщества дайджестом: главное за месяц, цифры, цитата, релизы. Полный список событий — в разделе «Хронология».", "", ...issues.map((g) => `- [№${g.issue}, ${g.title}: ${g.lead.headline}](${SITE}/gazeta/${g.month}/index.md)`), ""]
  : [];

const order = [...sections.entries()].filter(([, s]) => s.pages.length).sort((a, b) => (a[0].split("/").length - b[0].split("/").length) || a[1].weight - b[1].weight);

const api = `## MCP-сервер

Если ты агент с поддержкой MCP, подключи [host.pink/mcp](${SITE}/mcp) (Streamable HTTP, без ключей, MCP 2025-03-26 … 2026-07-28). Тулзы: ip_lookup, domain_lookup, asn_lookup, prefix_lookup, dns_records, tcp_ping, check_availability, subnet_calc, search_knowledge_base, read_page, site_map, ask_knowledge_base.

## Инструменты (для агентов: ?json на любом адресе, ?plain — текст без цветов)

- [Досье IP](${SITE}/8.8.8.8?json): владелец, ASN, гео, PTR, открытые порты и CVE (Shodan InternetDB), блоклисты, Tor, RPKI, видимость, whois, карта связности до Tier 1
- [Досье домена](${SITE}/example.com?json): DNS (SPF, DMARC, CAA, DNSSEC), HTTP-заголовки, доступность из РФ с домашних провайдеров, сервер, сертификаты и поддомены из CT, регистрация (RDAP)
- [Досье ASN](${SITE}/AS13335?json): владелец, PeeringDB, анонсы, апстримы и клиенты, точки обмена трафиком, карта связности
- [Досье префикса](${SITE}/1.1.1.0/24?json): кто анонсирует, RPKI, видимость, арифметика подсети
- [Мой IP](${SITE}/ip?json): адрес, ASN, город и дата-центр Cloudflare запрашивающего
- [DNS](${SITE}/dns/example.com?json): все записи через DoH 1.1.1.1, \`?t=MX\` для одного типа
- [TCP-пинг](${SITE}/ping/8.8.8.8:53?json): время TCP-рукопожатия с эджа Cloudflare
- [Проверка из разных стран](${SITE}/check/example.com?t=http&json): пробы Globalping в РФ (в т.ч. домашние провайдеры) и мире; t = http | ping | tcp | dns | mtr
- [Калькулятор подсетей](${SITE}/calc/10.0.0.0/22?json): IPv4 и IPv6
- [Поиск по базе](${SITE}/search?q=xhttp&json): полнотекстовый, возвращает URL с якорями на разделы
- [Вопрос ИИ по базе](${SITE}/ask?q=bbr&json): ответ со ссылками на источники

Лимиты: 30 проверок в минуту с IP, 3 вопроса ИИ в минуту. Кириллицу в query-параметрах кодируй (percent-encoding).`;

const index = [
  "# host.pink",
  "",
  "> Справочник и сетевые тулзы для тех, кто держит серверы: база знаний по Remnawave, Bedolaga, Xray и обходу блокировок в РФ (BedolagaBD, 108 документов с пруфами), досье IP, доменов и ASN, DNS, проверки доступности из РФ.",
  "",
  "Сайт без JavaScript: всё — обычный HTML. У каждой статьи есть markdown-версия: добавь `index.md` к адресу страницы. Инструменты отдают JSON по `?json` и простой текст для curl. Факты в базе датированы: рецепты обхода блокировок устаревают за 1–3 месяца, смотри на дату пруфа.",
  "",
  api,
  "",
  "## Словарь",
  "",
  `- [Словарь терминов](${SITE}/slovar/index.md): ТСПУ, БС, блок 16–20, мосты, selfsteal, Reality и ещё ${glossary.terms.length - 6} терминов простым языком`,
  "",
  ...hosterBlock,
  ...paymentBlock,
  ...protectionBlock,
  ...gazetaBlock,
  ...order.flatMap(([url, s]) => [
    `## ${s.title}`,
    "",
    ...(s.lede ? [`${s.lede}`, ""] : []),
    ...(url === "/gaidy/"
      ? guideCats.flatMap((c) => {
          const list = s.pages.filter((p) => p.category === c.id).sort((a, b) => a.weight - b.weight);
          return list.length ? [`### ${c.title}`, "", c.lede, "", ...list.map(line), ""] : [];
        })
      : s.pages.sort((a, b) => a.weight - b.weight).map(line)),
    "",
  ]),
  "## Optional",
  "",
  `- [Вся база одним файлом](${SITE}/llms-full.txt): все статьи в markdown, для загрузки в контекст целиком`,
  `- [Исходник базы](https://github.com/Rxflex/BedolagaBD): BedolagaBD, CC BY-SA 4.0`,
  `- [Донат](${SITE}/donate/): USDT TRC20/BEP20, BTC, ETH`,
  "",
].join("\n");
writeFileSync(join(PUB, "llms.txt"), index);

const full = [
  "# host.pink — база знаний целиком",
  "",
  "> Все статьи host.pink в markdown. Лицензия CC BY-SA 4.0. Ссылки вида [id=…](https://t.me/c/…) — пруфы на сообщения закрытого Telegram-чата сообщества.",
  "",
  ...order.flatMap(([, s]) => s.pages.sort((a, b) => a.weight - b.weight).map((p) => `\n\n---\n\n# ${s.title} › ${p.title}\n\nURL: ${SITE}${p.url}\n\n${p.body}`)),
  ...hosters.map((h) => `\n\n---\n\nURL: ${SITE}/hostery/${h.id}/\n\n${hosterMarkdown(h, SITE)}`),
  ...payments.map((p) => `\n\n---\n\nURL: ${SITE}/platezhki/${p.id}/\n\n${paymentMarkdown(p)}`),
  ...protection.map((p) => `\n\n---\n\nURL: ${SITE}/zashchita/${p.id}/\n\n${protectionMarkdown(p)}`),
  `\n\n---\n\nURL: ${SITE}/slovar/\n\n${glossaryMd}`,
].join("\n");
writeFileSync(join(PUB, "llms-full.txt"), full);

console.log(`llms: ${pages.length} страниц, llms.txt ${(index.length / 1024).toFixed(0)} КБ, llms-full.txt ${(full.length / 1024 / 1024).toFixed(1)} МБ`);
