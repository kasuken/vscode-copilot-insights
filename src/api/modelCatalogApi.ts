import * as vscode from "vscode";
import { MAX_CATALOG_BYTES, MODEL_CATALOG_URL, ModelCatalog, parseModelCatalog } from "../core/modelCatalog";

const CACHE_KEY = "copilotInsights.modelCatalog.v1";

export interface CatalogSnapshot {
  catalog: ModelCatalog;
  origin: "bundled" | "cached" | "updated";
}

export class ModelCatalogStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly readFile = (uri: vscode.Uri) => vscode.workspace.fs.readFile(uri),
  ) {}

  public async load(): Promise<CatalogSnapshot> {
    const bytes = await this.readFile(vscode.Uri.joinPath(this.context.extensionUri, "media", "model-catalog.json"));
    const catalog = this.parse(bytes);
    const cached = this.context.globalState.get<unknown>(CACHE_KEY);
    if (cached !== undefined) {
      try {
        const parsed = parseModelCatalog(cached);
        if (this.compare(parsed, catalog) >= 0) { return { catalog: parsed, origin: "cached" }; }
      } catch { return { catalog, origin: "bundled" }; }
    }
    return { catalog, origin: "bundled" };
  }

  public async refresh(previous: CatalogSnapshot): Promise<CatalogSnapshot> {
    const response = await fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok || !response.body) { throw new Error("Catalog download failed"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        size += value.byteLength;
        if (size > MAX_CATALOG_BYTES) { throw new Error("Catalog exceeds size limit"); }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const catalog = this.parse(Buffer.concat(chunks));
    if (this.compare(catalog, previous.catalog) < 0) { throw new Error("Catalog is older than the current snapshot"); }
    await this.context.globalState.update(CACHE_KEY, catalog);
    return { catalog, origin: "updated" };
  }

  private parse(bytes: Uint8Array): ModelCatalog {
    if (bytes.byteLength > MAX_CATALOG_BYTES) { throw new Error("Catalog exceeds size limit"); }
    return parseModelCatalog(JSON.parse(Buffer.from(bytes).toString("utf8")));
  }

  private compare(left: ModelCatalog, right: ModelCatalog): number {
    return left.reviewedAt.localeCompare(right.reviewedAt) || left.revision.localeCompare(right.revision, "en", { numeric: true });
  }
}