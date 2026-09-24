// Сборка hostpink под все платформы → .generated/static/dl/ (отдаётся как статика host.pink/dl/…)
// Сборка воспроизводимая (-trimpath, без CGO): одинаковый код даёт одинаковые байты,
// поэтому wrangler не перезаливает бинарники, если TUI не менялся.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "tui");
const OUT = join(ROOT, ".generated", "static", "dl");
const VERSION = readFileSync(join(SRC, "VERSION"), "utf8").trim();

const targets = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["linux", "arm", "7"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
  ["windows", "arm64"],
  ["freebsd", "amd64"],
];

try {
  execFileSync("go", ["version"], { stdio: "ignore" });
} catch {
  console.error("build-tui: Go не найден, бинарники hostpink не собраны");
  process.exit(process.env.CI ? 1 : 0);
}

mkdirSync(OUT, { recursive: true });
const sums = [];
for (const [os, arch, arm] of targets) {
  const name = `hostpink-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  const out = join(OUT, name);
  execFileSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags", `-s -w -buildid= -X main.version=${VERSION}`, "-o", out, "."], {
    cwd: SRC,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch, ...(arm ? { GOARM: arm } : {}) },
  });
  sums.push(`${createHash("sha256").update(readFileSync(out)).digest("hex")}  ${name}`);
}
writeFileSync(join(OUT, "SHA256SUMS"), sums.join("\n") + "\n");
writeFileSync(join(OUT, "version.txt"), VERSION + "\n");
console.log(`build-tui: hostpink ${VERSION}, ${targets.length} платформ → ${OUT}`);
