// Зеркало реестра плагинов hostpink на host.pink.
// Источник — подмодуль vendor/hostpink-registry (github.com/Rxflex/hostpink-registry).
// Из РФ GitHub открывается не везде, поэтому клиент сначала берёт host.pink/plugins.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "vendor", "hostpink-registry", "hostpink-registry.json");
const OUT = join(ROOT, ".generated", "static");

if (!existsSync(SRC)) {
  console.error("build-plugins: нет vendor/hostpink-registry, выполни git submodule update --init");
  process.exit(1);
}
const reg = JSON.parse(readFileSync(SRC, "utf8"));
for (const p of reg.plugins) {
  if (!/^[0-9a-f]{40}$/.test(p.ref) || p.files.some((f) => !/^[0-9a-f]{64}$/.test(f.sha256))) {
    throw new Error(`плагин ${p.id} не закреплён: в реестре запусти node scripts/registry.mjs --pin`);
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "plugins.json"), JSON.stringify(reg) + "\n");
console.log(`plugins: зеркало реестра, ${reg.plugins.length} плагинов`);
