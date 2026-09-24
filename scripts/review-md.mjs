// Разбор host.pink, факты с официального сайта и пометки проверки — общие для карточек
// хостеров, платёжек и защиты в markdown-копиях и поиске.

const CHECK = { outdated: "устарело", disputed: "спорно", unverified: "не подтверждено" };

export function checkMark(x) {
  const label = CHECK[x.check];
  if (!label) return "";
  return ` [${label}${x.check_note ? `: ${x.check_note}` : ""}]`;
}

export function reviewMd(r, o) {
  const out = [];
  if (r) {
    out.push("## Разбор host.pink", "");
    if (r.verdict) out.push(`**${r.verdict}**`, "");
    if (r.text) out.push(r.text, "");
    if (r.for?.length) out.push("Кому подходит:", ...r.for.map((x) => `- ${x}`), "");
    if (r.against?.length) out.push("Кому не стоит:", ...r.against.map((x) => `- ${x}`), "");
    const fresh = r.fresh === "stale" ? " Часть данных устарела." : r.fresh === "dead" ? " Похоже, сервис не работает." : "";
    out.push(`Разбор от ${r.checked}.${fresh}`, "");
  }
  if (o) {
    out.push("## С официального сайта", "");
    for (const f of o.facts ?? []) out.push(`- ${f.text} ([страница](${f.url}))`);
    if (o.unavailable) out.push(`Сайт проверить не удалось: ${o.unavailable}`);
    out.push("", `Проверено ${o.checked}${o.url ? ` на ${o.url}` : ""}.`, "");
  }
  return out.join("\n");
}

export function reviewPlain(r, o) {
  return [r?.verdict, r?.text, ...(r?.for ?? []), ...(r?.against ?? []), ...(o?.facts ?? []).map((f) => f.text)].filter(Boolean).join("\n");
}
