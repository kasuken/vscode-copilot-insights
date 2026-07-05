// Copies codicon assets from @vscode/codicons into media/codicons so the
// webview can load them locally (no remote/network dependency at runtime).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@vscode", "codicons", "dist");
const dest = join(root, "media", "codicons");

mkdirSync(dest, { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) {
  cpSync(join(src, file), join(dest, file));
}
console.log("Copied codicon assets to media/codicons");
