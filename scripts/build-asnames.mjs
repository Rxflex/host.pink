// Имена автономных систем из RIPE asn.txt → 512 статических шардов /asn/N.json.
// Статика бесплатна, так что Worker достаёт имя любой AS без внешних запросов.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".generated", "asn.txt");
const OUT = join(ROOT, ".generated", "static", "asn");
export const SHARDS = 512;

// как их зовут в индустрии, а не в реестре
const KNOWN = {
  174: "Cogent", 701: "Verizon", 1299: "Arelion", 2914: "NTT", 3257: "GTT", 3320: "DTAG", 3356: "Lumen", 3491: "PCCW",
  5511: "Orange", 6453: "TATA", 6461: "Zayo", 6762: "Sparkle", 6830: "Liberty Global", 7018: "AT&T", 12956: "Telxius",
  6939: "Hurricane Electric", 12389: "Rostelecom", 20485: "TransTeleCom", 31133: "MegaFon", 8359: "MTS", 3216: "Beeline",
  9002: "RETN", 1273: "Vodafone", 4637: "Telstra", 7474: "Optus", 38561: "NTT AU", 2497: "IIJ", 4766: "Korea Telecom",
  13335: "Cloudflare", 15169: "Google", 16509: "Amazon", 8075: "Microsoft", 32934: "Meta", 20940: "Akamai", 24940: "Hetzner",
  16276: "OVH", 14061: "DigitalOcean", 13238: "Yandex", 47764: "VK", 49505: "Selectel", 9123: "Timeweb",
};

const LEGAL = /\b(PJSC|OJSC|CJSC|JSC|PAO|OOO|LLC|L\.L\.C\.|Inc\.?|Ltd\.?|Limited|GmbH|AG|AB|B\.V\.|BV|S\.A\.|SA|S\.p\.A\.|Corp\.?|Corporation|Co\.|Company|Joint Stock|Public|Parent|Holdings?|Group|S\.R\.L\.|SRL|sp\. z o\.o\.|Oy|AS|A\/S|N\.V\.)\b\.?/gi;

function short(asn, rest) {
  if (KNOWN[asn]) return KNOWN[asn];
  const noCc = rest.replace(/,\s*[A-Z]{2}$/, "");
  let org = noCc.includes(" - ") ? noCc.split(" - ").slice(1).join(" - ") : noCc.split(" ").slice(1).join(" ") || noCc;
  org = org.replace(LEGAL, " ").replace(/[",]/g, " ").replace(/\s+/g, " ").trim();
  if (!org) org = noCc.split(" ")[0];
  return org.length > 22 ? org.slice(0, 21).trim() + "…" : org;
}

async function source() {
  const fresh = existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < 7 * 86400000;
  if (fresh) return readFileSync(CACHE, "utf8");
  const r = await fetch("https://ftp.ripe.net/ripe/asnames/asn.txt");
  if (!r.ok) {
    if (existsSync(CACHE)) return readFileSync(CACHE, "utf8");
    throw new Error(`asn.txt: HTTP ${r.status}`);
  }
  const t = await r.text();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, t);
  return t;
}

const shards = Array.from({ length: SHARDS }, () => ({}));
let n = 0;
for (const line of (await source()).split("\n")) {
  const m = line.match(/^(\d+) (.+)$/);
  if (!m) continue;
  const asn = Number(m[1]);
  const full = m[2].trim();
  shards[asn % SHARDS][asn] = [short(asn, full), full];
  n++;
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
shards.forEach((s, i) => writeFileSync(join(OUT, `${i}.json`), JSON.stringify(s)));
console.log(`asnames: ${n} AS → ${SHARDS} шардов`);
