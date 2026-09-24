// Шорткоды схем (flow, stack, waterfall, bars, compare) → обычный markdown.
// Нужно для markdown-копий статей, llms-full.txt и поискового индекса: агенту и поиску схема нужна словами, а не синтаксисом Hugo.

const lines = (inner) => inner.split("\n").map((l) => l.trim()).filter(Boolean);
const cells = (l) => l.split("|").map((c) => c.trim());
const caption = (attrs) => attrs.match(/caption="([^"]*)"/)?.[1] ?? "";
const attr = (attrs, name) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

const render = {
  flow(attrs, inner) {
    const parts = lines(inner).map((l, i) => {
      const [node, label] = cells(l);
      const name = node.replace(/^!/, "");
      return i === 0 ? name : `→ ${label ? `(${label}) ` : ""}${name}`;
    });
    return `**Схема:** ${parts.join(" ")}`;
  },
  stack(attrs, inner) {
    const unit = attr(attrs, "unit");
    const rows = lines(inner).map(cells);
    const total = rows.reduce((s, r) => s + Number(r[1] || 0), 0);
    return [`| Часть | ${unit || "Значение"} |`, "|---|---:|", ...rows.map((r) => `| ${r[0]}${r[2] === "payload" ? " (полезная нагрузка)" : ""} | ${r[1]} |`), `| **Итого** | **${total}** |`].join("\n");
  },
  waterfall(attrs, inner) {
    const unit = attr(attrs, "unit") || "мс";
    const rows = lines(inner).map(cells);
    const end = Math.max(...rows.map((r) => Number(r[1]) + Number(r[2])));
    return [`| Фаза | Начало, ${unit} | Длительность, ${unit} |`, "|---|---:|---:|", ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`), `| **Всего** | | **${end}** |`].join("\n");
  },
  bars(attrs, inner) {
    const unit = attr(attrs, "unit");
    const rows = lines(inner).map(cells);
    return [`| | ${unit || "Значение"} |`, "|---|---:|", ...rows.map((r) => `| ${r[0].replace(/^!/, "")} | ${r[1]} |`)].join("\n");
  },
  compare(attrs, inner) {
    const [bad, good = ""] = inner.split(/\n---\n/);
    return `**${attr(attrs, "bad") || "Плохо"}:**\n\n${bad.trim()}\n\n**${attr(attrs, "good") || "Хорошо"}:**\n\n${good.trim()}`;
  },
};

export function shortcodesToMarkdown(md) {
  return md.replace(/\{\{<\s*(flow|stack|waterfall|bars|compare)\b([^>]*)>\}\}\n?([\s\S]*?)\{\{<\s*\/\1\s*>\}\}/g, (_, name, attrs, inner) => {
    const body = render[name](attrs, inner);
    const cap = caption(attrs);
    return `${body}\n\n${cap ? `*${cap}*\n` : ""}`;
  });
}
