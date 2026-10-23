import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function loadModule(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { parseModelCatalog, MODEL_CATALOG_URL, MAX_CATALOG_BYTES } = await loadModule(resolve(root, 'src/core/modelCatalog.ts'));
let payload;
if (process.argv[2] === '--website' && process.argv[3]) {
  const { GET } = await loadModule(resolve(process.argv[3], 'src/pages/resources/github-copilot.json.ts'));
  payload = await GET().text();
} else if (process.argv.length === 2) {
  const response = await fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) { throw new Error(`Catalog fetch failed: ${response.status}`); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_CATALOG_BYTES) { throw new Error('Catalog exceeds size limit'); }
    chunks.push(chunk);
  }
  payload = Buffer.concat(chunks).toString('utf8');
} else { throw new Error('Usage: node scripts/sync-model-catalog.mjs [--website ../website]'); }
if (Buffer.byteLength(payload) > MAX_CATALOG_BYTES) { throw new Error('Catalog exceeds size limit'); }
const catalog = parseModelCatalog(JSON.parse(payload));
const destination = resolve(root, 'media/model-catalog.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Bundled ${catalog.models.length} models, revision ${catalog.revision}`);