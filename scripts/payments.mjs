// Карточки платёжек (data/payments/*.json) для поиска, llms.txt и markdown-копий
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMark, reviewMd, reviewPlain } from "./review-md.mjs";

export const KIND = { white: "белая", grey: "серая", crypto: "крипта", telegram: "Telegram", other: "другое" };
export const STATE = { ok: "работает", issues: "работает с проблемами", dead: "не работает", unknown: "нет данных" };
const BOT = { yes: "есть интеграция", no: "нет", unknown: "нет данных" };

export function loadPayments(root) {
  const dir = join(root, "data", "payments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

const item = (x) => `- ${x.text}${x.date ? ` (${x.date}${x.proof ? `, [пруф](${x.proof})` : ""})` : ""}${checkMark(x)}`;
const list = (title, arr) => (arr?.length ? `## ${title}\n\n${arr.map(item).join("\n")}\n` : "");

export function paymentMarkdown(p) {
  const s = p.status ?? {};
  const b = p.bedolaga ?? {};
  return [
    `# ${p.name}`,
    "",
    `> ${p.summary ?? ""}`,
    "",
    `- Тип: ${KIND[p.kind] ?? "—"}`,
    p.aliases?.length ? `- Ещё называют: ${p.aliases.join(", ")}` : "",
    `- Статус: ${STATE[s.state] ?? STATE.unknown}${s.note ? ` — ${s.note}` : ""}${s.date ? ` (${s.date})` : ""}`,
    p.methods?.length ? `- Принимает: ${p.methods.join(", ")}` : "",
    `- В Bedolaga: ${BOT[b.state] ?? BOT.unknown}${b.note ? ` — ${b.note}` : ""}`,
    p.site ? `- Сайт: ${p.site}` : "",
    "",
    list("Хвалят", p.pros),
    list("Ругают", p.cons),
    list("Комиссии и выплаты", p.fees),
    list("Что требуют при подключении", p.requirements),
    p.timeline?.length ? `## Что случалось\n\n${p.timeline.map((t) => `- ${t.date}: ${t.text}${t.proof ? ` ([пруф](${t.proof}))` : ""}${checkMark(t)}`).join("\n")}\n` : "",
    reviewMd(p.review, p.official),
    "Пункты выше — пересказ сообщений чата сообщества Bedolaga Social Club с пометками проверки; разбор — мнение редакции host.pink.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// для поиска: без ссылок и служебных строк
export function paymentPlain(p) {
  return [p.name, (p.aliases ?? []).join(" "), p.summary, p.status?.note, p.bedolaga?.note, ...["pros", "cons", "fees", "requirements"].flatMap((k) => (p[k] ?? []).map((x) => x.text)), ...(p.timeline ?? []).map((x) => `${x.date} ${x.text}`), reviewPlain(p.review, p.official)]
    .filter(Boolean)
    .join("\n");
}
