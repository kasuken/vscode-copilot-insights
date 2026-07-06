// Copies webview runtime assets into media/ so they load locally with no
// remote/network dependency at runtime:
//   - codicon font + CSS from @vscode/codicons
//   - the Chart.js UMD bundle used to draw the history charts
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const media = join(root, "media");

const codiconSrc = join(root, "node_modules", "@vscode", "codicons", "dist");
const codiconDest = join(media, "codicons");
mkdirSync(codiconDest, { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) {
  cpSync(join(codiconSrc, file), join(codiconDest, file));
}
console.log("Copied codicon assets to media/codicons");

cpSync(
  join(root, "node_modules", "chart.js", "dist", "chart.umd.min.js"),
  join(media, "chart.umd.min.js")
);
console.log("Copied Chart.js bundle to media/chart.umd.min.js");
