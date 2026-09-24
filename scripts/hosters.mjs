// Карточки хостеров (data/hosters/*.json) для поиска, llms.txt и markdown-копий
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STATE = { ok: "из РФ работает", partial: "из РФ частично", blocked: "из РФ в блоке", unknown: "нет данных" };

export function loadHosters(root) {
  const dir = join(root, "data", "hosters");
  if (!existsSync(dir)) return [];
  const countries = JSON.parse(readFileSync(join(root, "data", "countries.json"), "utf8"));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_") && !f.startsWith("zz-"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .map((h) => ({ ...h, countryNames: (h.countries ?? []).map((c) => countries[c] ?? c) }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

const item = (x) => `- ${x.text}${x.date ? ` (${x.date}${x.proof ? `, [пруф](${x.proof})` : ""})` : ""}`;

export function hosterMarkdown(h, site = "https://host.pink") {
  const a = h.ru_access ?? {};
  return [
    `# ${h.name}`,
    "",
    `> ${h.summary ?? ""}`,
    "",
    `- Группа: ${h.group === "ru" ? "российский" : "зарубежный"}`,
    h.aliases?.length ? `- Ещё называют: ${h.aliases.join(", ")}` : "",
    `- Доступность из РФ: ${STATE[a.state] ?? STATE.unknown}${a.note ? ` — ${a.note}` : ""}${a.date ? ` (${a.date})` : ""}`,
    h.countryNames?.length ? `- Страны: ${h.countryNames.join(", ")}` : "",
    h.asn?.length ? `- ASN: ${h.asn.map((n) => `[AS${n}](${site}/AS${n})`).join(", ")}` : "",
    h.site ? `- Сайт: ${h.site}` : "",
    h.good_for?.length ? `- Берут под: ${h.good_for.join(", ")}` : "",
    h.avoid_for?.length ? `- Не советуют под: ${h.avoid_for.join(", ")}` : "",
    "",
    h.pros?.length ? `## Хвалят\n\n${h.pros.map(item).join("\n")}\n` : "",
    h.cons?.length ? `## Ругают\n\n${h.cons.map(item).join("\n")}\n` : "",
    h.prices?.length ? `## Цены, которые называли\n\n${h.prices.map(item).join("\n")}\n` : "",
    h.timeline?.length ? `## Что случалось\n\n${h.timeline.map((t) => `- ${t.date}: ${t.text}${t.proof ? ` ([пруф](${t.proof}))` : ""}`).join("\n")}\n` : "",
    "Пересказ сообщений чата сообщества Bedolaga Social Club, а не оценка редакции: даты важнее выводов.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// для поиска: без ссылок и служебных строк
export function hosterPlain(h) {
  return [h.name, (h.aliases ?? []).join(" "), h.summary, h.ru_access?.note, ...(h.pros ?? []).map((x) => x.text), ...(h.cons ?? []).map((x) => x.text), ...(h.prices ?? []).map((x) => x.text), ...(h.timeline ?? []).map((x) => `${x.date} ${x.text}`)]
    .filter(Boolean)
    .join("\n");
}
