// QR-коды для /donate: SVG на сборке, никакого JS в браузере
import { mkdir, readFile, writeFile } from "node:fs/promises";
import QRCode from "qrcode";

const yaml = await readFile(new URL("../data/donate.yaml", import.meta.url), "utf8");
const coins = yaml.split(/^- /m).slice(1).map((block) => ({
  id: block.match(/^id: (.+)$/m)?.[1].trim(),
  addr: block.match(/addr: "?([^"\n]+)"?/)?.[1].trim(),
}));

const out = new URL("../.generated/static/qr/", import.meta.url);
await mkdir(out, { recursive: true });
for (const { id, addr } of coins) {
  const svg = await QRCode.toString(addr, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#2a1030", light: "#ffffff" } });
  await writeFile(new URL(`${id}.svg`, out), svg);
}
console.log(`qr: ${coins.length} кодов`);
