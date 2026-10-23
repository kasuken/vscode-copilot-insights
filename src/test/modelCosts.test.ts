import * as assert from "assert";
import * as vscode from "vscode";
import { CatalogSnapshot, ModelCatalogStore } from "../api/modelCatalogApi";
import { MAX_CATALOG_BYTES, ModelCatalog } from "../core/modelCatalog";
import { renderModelCostsShell } from "../ui/webview/modelCosts";

const cacheKey = "copilotInsights.modelCatalog.v1";
const extensionUri = vscode.Uri.parse("file:///catalog-extension");

function catalog(revision = "revision-9", reviewedAt = "2026-10-23"): ModelCatalog {
  return {
    schemaVersion: 1, revision, reviewedAt, currency: "USD", tokensPerUnit: 1000000, creditCostUsd: 0.01,
    sources: Object.fromEntries(["pricing", "models", "auto"].map(key => [key, {
      title: key, url: `https://docs.github.com/en/copilot/${key}`,
    }])),
    models: [{ id: "test-model", name: "Test model", provider: "Test provider", access: "paid",
      rates: { input: 2, cached: 0.2, write: null, output: 12 } }],
    access: { paid: "Paid plans" }, notes: {}, groups: [], guidance: [], plans: [],
    selectionOptions: [], autoTiers: [], hydraPatterns: [],
    billingRules: { autoDiscount: 0.1, autoDiscountAccess: ["paid"], maxAutoDiscount: 0.3,
      maxAutoDiscountUntil: "2026-10-28", reviewedAt: "2026-10-23", hydraFusion: "Standard rates" },
  };
}

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

function stream(chunks: Uint8Array[], failure?: Error) {
  const events = { reads: 0, cancelled: 0, released: 0 };
  const reader = {
    async read() {
      const index = events.reads++;
      if (failure) { throw failure; }
      return index < chunks.length ? { done: false, value: chunks[index] } : { done: true };
    },
    async cancel() { events.cancelled++; },
    releaseLock() { events.released++; },
  };
  return { events, response: { ok: true, body: { getReader: () => reader } } as unknown as Response };
}

suite("Model costs regression", () => {
  let restore: (() => void)[];
  let bundled: Uint8Array;
  let cache: Map<string, unknown>;
  let writes: { key: string; value: unknown }[];
  let reads: string[];
  let rejectWrite: boolean;
  let rejectRead: boolean;
  let store: ModelCatalogStore;

  function replace(target: object, key: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (descriptor) { Object.defineProperty(target, key, descriptor); }
      else { Reflect.deleteProperty(target, key); }
    });
  }

  setup(() => {
    restore = [];
    bundled = bytes(catalog());
    cache = new Map();
    writes = [];
    reads = [];
    rejectWrite = false;
    rejectRead = false;
    replace(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
    replace(AbortSignal, "timeout", () => new AbortController().signal);
    const context = {
      extensionUri,
      globalState: {
        get(key: string) { assert.strictEqual(key, cacheKey); return cache.get(key); },
        async update(key: string, value: unknown) {
          writes.push({ key, value });
          if (rejectWrite) { throw new Error("Cache write failed"); }
          cache.set(key, value);
        },
      },
    } as unknown as vscode.ExtensionContext;
    store = new ModelCatalogStore(context, async (uri: vscode.Uri) => {
      reads.push(uri.toString());
      if (rejectRead) { throw new Error("Bundled read failed"); }
      return bundled;
    });
  });

  teardown(() => { for (const undo of restore.reverse()) { undo(); } });

  for (const entry of [
    { name: "absent cache", cached: undefined },
    { name: "corrupt cache", cached: "not a catalog" },
    { name: "unsupported cache schema", cached: { ...catalog(), schemaVersion: 2 } },
    { name: "older cache date", cached: catalog("revision-99", "2026-10-22") },
    { name: "older same-date numeric cache revision", cached: catalog("revision-8") },
  ]) {
    test(`load uses bundled data for ${entry.name}`, async () => {
      if (entry.cached !== undefined) { cache.set(cacheKey, entry.cached); }
      assert.deepStrictEqual(await store.load(), { catalog: catalog(), origin: "bundled" });
      assert.deepStrictEqual(reads, [vscode.Uri.joinPath(extensionUri, "media", "model-catalog.json").toString()]);
      assert.deepStrictEqual(writes, []);
      assert.strictEqual(cache.get(cacheKey), entry.cached);
    });
  }

  for (const entry of [
    { name: "newer cache date", cached: catalog("revision-1", "2026-10-24") },
    { name: "newer same-date numeric cache revision", cached: catalog("revision-10") },
    { name: "equal cache revision", cached: catalog() },
  ]) {
    test(`load selects ${entry.name}`, async () => {
      const cached = structuredClone(entry.cached);
      cached.models[0].name = "Cached model";
      cache.set(cacheKey, cached);
      assert.deepStrictEqual(await store.load(), { catalog: cached, origin: "cached" });
      assert.deepStrictEqual(writes, []);
    });
  }

  for (const entry of [
    { name: "malformed bundled JSON", payload: Buffer.from("{") },
    { name: "invalid bundled schema", payload: bytes({ ...catalog(), schemaVersion: 2 }) },
    { name: "oversized bundled data", payload: Buffer.alloc(MAX_CATALOG_BYTES + 1, " ") },
  ]) {
    test(`load rejects ${entry.name} even with a valid cache`, async () => {
      cache.set(cacheKey, catalog("revision-10"));
      bundled = entry.payload;
      await assert.rejects(() => store.load());
      assert.deepStrictEqual(writes, []);
      assert.deepStrictEqual(cache.get(cacheKey), catalog("revision-10"));
    });
  }

  test("load propagates bundled read errors without changing cache", async () => {
    cache.set(cacheKey, catalog("revision-10"));
    rejectRead = true;
    await assert.rejects(() => store.load(), /Bundled read failed/);
    assert.deepStrictEqual(cache.get(cacheKey), catalog("revision-10"));
    assert.deepStrictEqual(writes, []);
  });

  test("refresh uses the fixed URL with no redirects and a 15-second timeout before persisting", async () => {
    const previous = await store.load();
    const original = structuredClone(previous);
    const updated = catalog("revision-1", "2026-10-24");
    updated.models[0].name = "Updated model";
    const payload = bytes({ ...updated, untrustedExtra: "discard me" });
    const download = stream([payload.subarray(0, 17), payload.subarray(17)]);
    const signal = new AbortController().signal;
    const timeouts: number[] = [];
    const requests: { url: unknown; options: unknown }[] = [];
    replace(AbortSignal, "timeout", (milliseconds: number) => { timeouts.push(milliseconds); return signal; });
    replace(globalThis, "fetch", async (url: unknown, options: unknown) => {
      requests.push({ url, options });
      return download.response;
    });
    assert.deepStrictEqual(await store.refresh(previous), { catalog: updated, origin: "updated" });
    assert.deepStrictEqual(timeouts, [15000]);
    assert.deepStrictEqual(requests, [{ url: "https://www.emanuelebartolesi.com/resources/github-copilot.json",
      options: { signal, redirect: "error" } }]);
    assert.deepStrictEqual(writes, [{ key: cacheKey, value: updated }]);
    assert.deepStrictEqual(cache.get(cacheKey), updated);
    assert.deepStrictEqual(previous, original);
    assert.deepStrictEqual(download.events, { reads: 3, cancelled: 1, released: 1 });
    assert.deepStrictEqual(await store.load(), { catalog: updated, origin: "cached" });
  });

  for (const revision of ["revision-10", "revision-9"]) {
    test(`refresh accepts same-date ${revision}`, async () => {
      const previous = await store.load();
      const updated = catalog(revision);
      updated.models[0].name = "Refreshed model";
      replace(globalThis, "fetch", async () => stream([bytes(updated)]).response);
      assert.deepStrictEqual(await store.refresh(previous), { catalog: updated, origin: "updated" });
      assert.deepStrictEqual(writes, [{ key: cacheKey, value: updated }]);
      assert.deepStrictEqual(cache.get(cacheKey), updated);
    });
  }

  for (const size of [MAX_CATALOG_BYTES - 1, MAX_CATALOG_BYTES]) {
    test(`refresh accepts a valid payload of ${size} bytes`, async () => {
      const previous = await store.load();
      const payload = Buffer.from(JSON.stringify(catalog()).padEnd(size, " "));
      assert.strictEqual(payload.byteLength, size);
      replace(globalThis, "fetch", async () => stream([payload]).response);
      assert.deepStrictEqual(await store.refresh(previous), { catalog: catalog(), origin: "updated" });
      assert.deepStrictEqual(writes, [{ key: cacheKey, value: catalog() }]);
    });
  }

  async function preservedAfterFailure(previous: CatalogSnapshot, expected: RegExp, writeCount = 0) {
    const original = structuredClone(previous);
    const cached = cache.get(cacheKey);
    const savedCache = structuredClone(cached);
    await assert.rejects(() => store.refresh(previous), expected);
    assert.deepStrictEqual(previous, original);
    assert.strictEqual(cache.get(cacheKey), cached);
    assert.deepStrictEqual(cache.get(cacheKey), savedCache);
    assert.strictEqual(writes.length, writeCount);
    assert.deepStrictEqual(await store.load(), original);
  }

  for (const entry of [
    { name: "invalid schema", payload: bytes({ ...catalog("revision-10"), schemaVersion: 2 }), error: /Unsupported catalog/ },
    { name: "malformed JSON", payload: Buffer.from("{\"schemaVersion\":"), error: /JSON/ },
    { name: "older date despite a higher revision", payload: bytes(catalog("revision-99", "2026-10-22")), error: /older/ },
    { name: "older same-date numeric revision", payload: bytes(catalog("revision-9")), error: /older/ },
  ]) {
    test(`refresh preserves snapshot and cache after ${entry.name}`, async () => {
      cache.set(cacheKey, catalog("revision-10"));
      const previous = await store.load();
      const download = stream([entry.payload]);
      replace(globalThis, "fetch", async () => download.response);
      await preservedAfterFailure(previous, entry.error);
      assert.deepStrictEqual(download.events, { reads: 2, cancelled: 1, released: 1 });
    });
  }

  for (const entry of [
    { name: "non-OK HTTP", response: { ...stream([bytes(catalog("revision-11"))]).response, ok: false } },
    { name: "missing response body", response: { ok: true, body: null } },
  ]) {
    test(`refresh preserves snapshot and cache after ${entry.name}`, async () => {
      cache.set(cacheKey, catalog("revision-10"));
      const previous = await store.load();
      replace(globalThis, "fetch", async () => entry.response);
      await preservedAfterFailure(previous, /Catalog download failed/);
    });
  }

  test("refresh stops an oversized stream and preserves snapshot and cache", async () => {
    cache.set(cacheKey, catalog("revision-10"));
    const previous = await store.load();
    const download = stream([Buffer.alloc(MAX_CATALOG_BYTES - 1, " "), Buffer.alloc(2, " "), bytes(catalog())]);
    replace(globalThis, "fetch", async () => download.response);
    await preservedAfterFailure(previous, /size limit/);
    assert.deepStrictEqual(download.events, { reads: 2, cancelled: 1, released: 1 });
  });

  test("refresh preserves snapshot and cache after a network rejection", async () => {
    cache.set(cacheKey, catalog("revision-10"));
    const previous = await store.load();
    replace(globalThis, "fetch", async () => { throw new Error("Network failed"); });
    await preservedAfterFailure(previous, /Network failed/);
  });

  test("refresh releases a failed stream and preserves snapshot and cache", async () => {
    cache.set(cacheKey, catalog("revision-10"));
    const previous = await store.load();
    const download = stream([], new Error("Stream failed"));
    replace(globalThis, "fetch", async () => download.response);
    await preservedAfterFailure(previous, /Stream failed/);
    assert.deepStrictEqual(download.events, { reads: 1, cancelled: 1, released: 1 });
  });

  test("refresh preserves snapshot and cache when persistence rejects", async () => {
    cache.set(cacheKey, catalog("revision-10"));
    const previous = await store.load();
    const updated = catalog("revision-11");
    replace(globalThis, "fetch", async () => stream([bytes(updated)]).response);
    rejectWrite = true;
    await preservedAfterFailure(previous, /Cache write failed/, 1);
    assert.deepStrictEqual(writes, [{ key: cacheKey, value: updated }]);
  });

  function shell(localize?: (value: string) => string) {
    return renderModelCostsShell({
      cspSource: "test-webview:",
      asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`test-webview:${uri.path}`),
    } as unknown as vscode.Webview, extensionUri, localize);
  }

  test("shell restricts scripts to a CSP nonce and uses only local assets", () => {
    const html = shell();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
    assert.strictEqual(scripts.length, 2);
    const nonce = /nonce="([a-zA-Z0-9]{32})"/.exec(scripts[0])?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`content="default-src 'none'; style-src test-webview:; font-src test-webview:; script-src 'nonce-${nonce}';"`));
    for (const script of scripts) { assert.ok(script.includes(`nonce="${nonce}"`)); }
    assert.ok(scripts[0].includes('type="application/json" id="labels"'));
    assert.deepStrictEqual([...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]), [
      "test-webview:/catalog-extension/media/codicons/codicon.css",
      "test-webview:/catalog-extension/media/model-costs.css",
      "test-webview:/catalog-extension/media/model-costs.js",
    ]);
    assert.doesNotMatch(html, /<script[^>]*src="(?:https?:)?\/\//);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  });

  test("shell pairs all accessible tabs and panels with initial selection and localized names", () => {
    const html = shell(label => `Localized ${label}`);
    assert.ok(html.includes('<nav role="tablist" aria-label="Localized Model Costs">'));
    const tabs = [...html.matchAll(/<button role="tab"[^>]*>([^<]*)<\/button>/g)];
    const panels = [...html.matchAll(/<section role="tabpanel"[^>]*>/g)];
    assert.strictEqual(tabs.length, 5);
    assert.strictEqual(panels.length, 5);
    ["Catalog", "Estimator", "Plans", "Guidance", "Sources"].forEach((label, index) => {
      assert.strictEqual(tabs[index][0], `<button role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">Localized ${label}</button>`);
      assert.strictEqual(panels[index][0], `<section role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index ? " hidden" : ""}>`);
    });
    for (const label of ["Open guide", "Refresh catalog"]) {
      assert.ok(html.includes(`title="Localized ${label}" aria-label="Localized ${label}"`));
    }
    for (const id of ["input", "cached", "write", "output"]) {
      assert.ok(html.includes(`<input id="${id}" type="number" min="0" max="1000000000000" step="1" required aria-describedby="token-note estimate-error">`));
    }
    assert.ok(html.includes('<p id="token-note"'));
    assert.ok(html.includes('<p id="estimate-error" class="warning" role="status" hidden>'));
    assert.ok(html.includes('<output id="estimate-result" aria-live="polite">'));
  });

  test("shell escapes localized HTML and prevents JSON script breakout", () => {
    const hostile = '<img src=x onerror="alert(1)"> & \' </script><script>attack()</script>';
    const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39; &lt;/script&gt;&lt;script&gt;attack()&lt;/script&gt;';
    const html = shell(() => hostile);
    assert.ok(html.includes(`<title>${escaped}</title>`));
    assert.ok(html.includes(`<h1>${escaped}</h1>`));
    assert.ok(html.includes(`title="${escaped}" aria-label="${escaped}"`));
    assert.ok(html.includes(`<option value="default">${escaped}</option>`));
    assert.doesNotMatch(html, /<img|<script>attack/);
    assert.strictEqual([...html.matchAll(/<script\b/g)].length, 2);
    const encoded = /<script[^>]*id="labels">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(encoded);
    assert.ok(encoded.includes("\\u003c/script>"));
    assert.doesNotMatch(encoded, /</);
    const labels = JSON.parse(encoded);
    assert.strictEqual(labels["Model Costs"], hostile);
    assert.strictEqual(labels["Open guide"], hostile);
    assert.strictEqual(labels["No models match these filters."], hostile);
  });
});