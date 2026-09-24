// Карточки защиты от DDoS (data/protection/*.json) для поиска, llms.txt и markdown-копий
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMark, reviewMd, reviewPlain } from "./review-md.mjs";

export const PKIND = { proxy: "прокси L7", network: "сеть L3/L4", hosting: "хостинг с защитой" };
export const PSTATE = { ok: "из РФ работает", partial: "из РФ частично", blocked: "из РФ в блоке", unknown: "нет данных" };

export function loadProtection(root) {
  const dir = join(root, "data", "protection");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

const item = (x) => `- ${x.text}${x.date ? ` (${x.date}${x.proof ? `, [пруф](${x.proof})` : ""})` : ""}${checkMark(x)}`;
const list = (title, arr) => (arr?.length ? `## ${title}\n\n${arr.map(item).join("\n")}\n` : "");

export function protectionMarkdown(p) {
  const a = p.ru_access ?? {};
  return [
    `# ${p.name}`,
    "",
    `> ${p.summary ?? ""}`,
    "",
    p.sponsor ? "- Спонсор host.pink: в карточке только факты из базы сообщества" : "",
    `- Тип: ${PKIND[p.kind] ?? "—"}`,
    p.levels?.length ? `- Уровни: ${p.levels.join(", ")}` : "",
    p.aliases?.length ? `- Ещё называют: ${p.aliases.join(", ")}` : "",
    `- Доступность из РФ: ${PSTATE[a.state] ?? PSTATE.unknown}${a.note ? ` — ${a.note}` : ""}${a.date ? ` (${a.date})` : ""}`,
    p.good_for?.length ? `- Ставят перед: ${p.good_for.join(", ")}` : "",
    p.avoid_for?.length ? `- Не советуют для: ${p.avoid_for.join(", ")}` : "",
    p.site ? `- Сайт: ${p.site}` : "",
    "",
    list("Хвалят", p.pros),
    list("Ругают", p.cons),
    list("Цены, которые называли", p.prices),
    p.timeline?.length ? `## Что случалось\n\n${p.timeline.map((t) => `- ${t.date}: ${t.text}${t.proof ? ` ([пруф](${t.proof}))` : ""}${checkMark(t)}`).join("\n")}\n` : "",
    reviewMd(p.review, p.official),
    "Пункты выше — пересказ сообщений чата сообщества Bedolaga Social Club с пометками проверки; разбор — мнение редакции host.pink.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function protectionPlain(p) {
  return [p.name, (p.aliases ?? []).join(" "), "защита от DDoS анти-ддос", p.summary, p.ru_access?.note, ...["pros", "cons", "prices"].flatMap((k) => (p[k] ?? []).map((x) => x.text)), ...(p.timeline ?? []).map((x) => `${x.date} ${x.text}`), reviewPlain(p.review, p.official)]
    .filter(Boolean)
    .join("\n");
}
