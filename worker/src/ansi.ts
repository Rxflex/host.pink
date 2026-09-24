// Терминальная морда: curl host.pink — логотип, гайд и цветной вывод. Цвет только для curl/wget/httpie, ?plain выключает.
import ads from "../../data/adslots.json";
import sponsors from "../../data/sponsors.json";

export type Paint = ReturnType<typeof paint>;

export function colorOk(req: Request, url: URL) {
  if (url.searchParams.has("plain") || url.searchParams.has("json")) return false;
  return /^(curl|wget|httpie|xh|hostpink)\b/i.test(req.headers.get("user-agent") ?? "");
}

export function paint(on: boolean) {
  const c = (code: string) => (s: string | number) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    on,
    pink: c("38;5;198"),
    pinkB: c("1;38;5;198"),
    bold: c("1"),
    dim: c("2"),
    ink: c("38;5;225"),
    green: c("38;5;42"),
    red: c("38;5;203"),
    yellow: c("38;5;214"),
    cyan: c("38;5;117"),
    jade: c("38;5;36"),
    jadeB: c("1;38;5;79"),
    dot(state?: string) {
      if (state === "up") return c("38;5;42")("●");
      if (state === "slow") return c("38;5;214")("◐");
      if (state === "down") return c("38;5;203")("○");
      return c("2")("·");
    },
  };
}

// 4-строчный шрифт на полублоках: host.pink
const GLYPH: Record<string, string[]> = {
  h: ["█   ", "█▀▀▄", "█  █", "    "],
  o: ["    ", "▄▀▀▄", "▀▄▄▀", "    "],
  s: ["    ", "▄▀▀▀", "▄▄▄▀", "    "],
  t: [" █ ", "▀█▀", " ▀▄", "   "],
  ".": [" ", " ", "▄", " "],
  p: ["    ", "█▀▀▄", "█▄▄▀", "█   "],
  i: ["▀", "█", "█", " "],
  n: ["    ", "█▀▀▄", "█  █", "    "],
  k: ["█   ", "█ ▄▀", "█▀▄ ", "    "],
};

function logo(p: Paint) {
  const word = (w: string) => [0, 1, 2, 3].map((r) => [...w].map((ch) => GLYPH[ch][r]).join(" "));
  const host = word("host"), pink = word(".pink");
  return host.map((row, r) => `  ${p.bold(p.ink(row))} ${p.pinkB(pink[r])}`).join("\n");
}

const cmd = (p: Paint, c: string, d: string) => `  ${p.cyan("curl")} ${p.pink(c.padEnd(40))} ${p.dim(d)}`;

export function homeGuide(req: Request, p: Paint) {
  const ip = req.headers.get("cf-connecting-ip") ?? "?";
  const cf = (req.cf ?? {}) as Record<string, any>;
  const where = [cf.city, cf.country].filter(Boolean).join(", ");
  const h2 = (s: string) => `\n ${p.pink("▌")} ${p.bold(s)}`;
  return [
    "",
    logo(p),
    "",
    `  ${p.ink("Справочник и сетевые тулзы для тех, кто держит серверы.")}`,
    `  ${p.dim("Браузер не нужен. JavaScript тем более.")}`,
    h2("Кто я"),
    `  ${p.bold(ip)}  ${p.dim(`AS${cf.asn ?? "?"} ${cf.asOrganization ?? ""}${where ? `, ${where}` : ""}, через Cloudflare ${cf.colo ?? "?"}`)}`,
    cmd(p, "host.pink/ip", "только адрес, для скриптов"),
    cmd(p, "host.pink/ip?full", "адрес, провайдер, город, TLS"),
    h2("Досье"),
    cmd(p, "host.pink/1.1.1.1", "IP: владелец, порты, CVE, RPKI, блоклисты"),
    cmd(p, "host.pink/example.com", "домен: DNS, HTTP, доступность из РФ"),
    cmd(p, "host.pink/AS13335", "ASN: анонсы, апстримы, IX"),
    cmd(p, "host.pink/1.1.1.0/24", "префикс: кто анонсирует, RPKI"),
    h2("Проверки"),
    cmd(p, "host.pink/dns/example.com", "все записи через DoH, ?t=MX для одной"),
    cmd(p, "host.pink/ping/8.8.8.8:53", "TCP-пинг с эджа Cloudflare"),
    cmd(p, "host.pink/check/example.com", "HTTP из РФ и мира, ?t=ping|tcp|dns|mtr"),
    cmd(p, "host.pink/calc/10.0.0.0/22", "калькулятор подсетей, v4 и v6"),
    h2("Для ИИ-агентов"),
    `  ${p.cyan("claude mcp add")} ${p.pink("--transport http host-pink https://host.pink/mcp")}`,
    `  ${p.dim("MCP-сервер: досье, проверки из РФ и база знаний прямо в агенте. Карта сайта: host.pink/llms.txt")}`,
    h2("База знаний"),
    `  ${p.cyan("curl")} ${p.pink('-G host.pink/search --data-urlencode "q=xhttp"')}`,
    `  ${p.cyan("curl")} ${p.pink('-G host.pink/ask --data-urlencode "q=как включить bbr?"')}`,
    `  ${p.dim("Кириллицу в URL кодируй через --data-urlencode, иначе Cloudflare ответит 400.")}`,
    h2("Мелочи"),
    `  ${p.pink("?json")}   ${p.dim("на любом адресе — JSON для скриптов")}`,
    `  ${p.pink("?plain")}  ${p.dim("без цветов, если пайпишь в файл")}`,
    `  ${p.dim("Лимит: 30 проверок в минуту с IP. Для мониторинга подними свой Uptime Kuma.")}`,
    ...sponsorBlock(p, "curl-home"),
    "",
    `  ${p.dim("Донат на хостинг и кофе:")} ${p.ink("USDT TRC20")} ${p.bold("TYHgzVKjxiBkvXnnrQdGaYQiCrzoEYjrr7")}`,
    `  ${p.dim("Остальные сети:")} ${p.pink("https://host.pink/donate/")}`,
    "",
  ].join("\n");
}

type Sponsor = (typeof sponsors)[number];
const sponsorUrl = (s: Sponsor, campaign: string) => `${s.url}?utm_source=host.pink&utm_medium=sponsor&utm_campaign=${campaign}`;
const adLabel = (s: Sponsor) => `Реклама · ${s.name}`;

// у каждого спонсора свой знак и цвет в терминале
function mark(p: Paint, s: Sponsor): { art: string[]; name: (t: string) => string; accent: (t: string) => string } {
  if (s.id === "redstone") {
    const bg = (t: string) => (p.on ? `\x1b[1;97;48;5;202m${t}\x1b[0m` : t);
    const org = (t: string) => (p.on ? `\x1b[38;5;202m${t}\x1b[0m` : t);
    return { art: [` ${bg("      ")} `, ` ${bg("  R   ")} `, ` ${bg("      ")} `], name: (t) => (p.on ? `\x1b[1;38;5;208m${t}\x1b[0m` : t), accent: org };
  }
  return { art: [" ▗▟▀▙▖  ", " ▐▙▄▟▌  ", "  ▝▀▘   "].map((l) => p.jade(l)), name: p.jadeB, accent: p.jade };
}

// блок спонсоров для curl host.pink: каждый со своим знаком и цветом
export function sponsorBlock(p: Paint, campaign: string): string[] {
  if (!sponsors.length) return [];
  const out = [`\n ${p.pink("▌")} ${p.bold(sponsors.length > 1 ? "Спонсоры" : "Спонсор")}`];
  for (const s of sponsors) {
    const m = mark(p, s);
    out.push(
      `  ${m.art[0]} ${m.name(s.name)}  ${p.bold(`${s.headline[0]} ${s.headline[1]}.`)}`,
      `  ${m.art[1]} ${p.dim(s.terminal[0])}`,
      `  ${m.art[2]} ${p.dim(s.terminal[1])}`,
      `           ${m.accent(sponsorUrl(s, campaign))}  ${p.dim(adLabel(s))}`,
      "",
    );
  }
  out.pop();
  out.push("", `  ${p.pink("+")} ${p.bold("Здесь может быть ваша реклама.")} ${p.dim("Читатели держат серверы, ноды и панели.")}`, `    ${p.dim("Telegram:")} ${p.pink(`${ads.contact.label}`)} ${p.dim(ads.contact.url)}`);
  return out;
}

export const pickSponsor = (topic?: string): Sponsor | undefined =>
  (topic && sponsors.find((s) => (s.topics as string[]).includes(topic))) || sponsors[Math.floor(Math.random() * sponsors.length)];

// одна строка в конце текстовых отчётов: случайный спонсор, чтобы все получали показы
export function sponsorLine(p: Paint, campaign: string): string {
  const s = pickSponsor();
  if (!s) return "";
  const m = mark(p, s);
  const lc = (t: string) => t[0].toLowerCase() + t.slice(1);
  return `  ${m.accent("▌")} ${m.name(s.name)} ${p.dim(`— ${lc(s.short)}. ${s.headline[0]} ${s.headline[1]}.`)}\n    ${m.accent(sponsorUrl(s, campaign))} ${p.dim(`(${lc(adLabel(s))})`)}`;
}

// раскраска текстового вывода досье: заголовки, ключи, статусы
export function paintReport(lines: string[], p: Paint) {
  if (!p.on) return lines.join("\n");
  return lines
    .map((l) => {
      if (l.startsWith("# ")) return `\n ${p.pinkB(l.slice(2))}`;
      const hm = l.match(/^## (.+?)(?: \((.+)\))?$/);
      if (hm) return `\n ${p.pink("▌")} ${p.bold(hm[1])}${hm[2] ? ` ${p.dim(hm[2])}` : ""}`;
      const kv = l.match(/^  (\S.{17}) (.*)$/);
      if (kv) return `  ${p.dim(kv[1])} ${kv[2]}`;
      return l;
    })
    .join("\n");
}
