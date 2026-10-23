import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { estimateModelCost, isCatalogSourceUrl, isCatalogStale, isExpired, parseModelCatalog, TokenEstimateInput } from "../core/modelCatalog";

const fixture = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../media/model-catalog.json"), "utf8"));
const now = new Date("2026-10-23T12:00:00Z");
const tokens: TokenEstimateInput = { input: 100000, cached: 20000, write: 10000, output: 10000, mode: "standard" };

suite("Model catalog", () => {
  test("accepts the complete bundled website contract", () => {
    const catalog = parseModelCatalog(fixture());
    assert.strictEqual(catalog.models.length, 26);
    assert.strictEqual(catalog.models[0].rates.write, null);
    assert.strictEqual(catalog.plans.length, 5);
    assert.strictEqual(catalog.guidance[0].fits.length, catalog.groups.length);
  });

  test("rejects unsupported units, malformed dates, missing rates and duplicate IDs", () => {
    for (const mutate of [
      (data: ReturnType<typeof fixture>) => { data.schemaVersion = 2; },
      (data: ReturnType<typeof fixture>) => { data.creditCostUsd = 1; },
      (data: ReturnType<typeof fixture>) => { data.reviewedAt = "2026-02-30"; },
      (data: ReturnType<typeof fixture>) => { delete data.models[0].rates.cached; },
      (data: ReturnType<typeof fixture>) => { data.models[0].rates.input = -1; },
      (data: ReturnType<typeof fixture>) => { data.models[0].rates.input = Infinity; },
      (data: ReturnType<typeof fixture>) => { data.models[1].id = data.models[0].id; },
      (data: ReturnType<typeof fixture>) => { data.models[0].longContext = data.models[0].rates; },
      (data: ReturnType<typeof fixture>) => { data.models = []; },
      (data: ReturnType<typeof fixture>) => { data.billingRules.autoDiscount = 1; },
      (data: ReturnType<typeof fixture>) => { data.guidance[0].fits = []; },
    ]) {
      const data = fixture();
      mutate(data);
      assert.throws(() => parseModelCatalog(data));
    }
  });

  test("rejects unsafe links and unknown access and note references", () => {
    for (const url of ["javascript:alert(1)", "https://docs.github.com.evil.example/a", "http://docs.github.com/a", "https://user@docs.github.com/a", "https://docs.github.com:444/a"]) {
      assert.strictEqual(isCatalogSourceUrl(url), false);
      const data = fixture();
      data.sources.pricing.url = url;
      assert.throws(() => parseModelCatalog(data));
    }
    assert.strictEqual(isCatalogSourceUrl("https://docs.github.com/en/copilot"), true);
    for (const field of ["access", "note"]) {
      const data = fixture();
      data.models[0][field] = "unknown";
      assert.throws(() => parseModelCatalog(data));
    }
  });

  test("counts cached reads and writes once and returns component costs", () => {
    const catalog = parseModelCatalog(fixture());
    const model = catalog.models.find(model => model.name === "GPT-5.6 Terra")!;
    const result = estimateModelCost(catalog, model, tokens, now);
    assert.ok(Math.abs(result.usd - 0.289) < 1e-10);
    assert.ok(Math.abs(result.credits - 28.9) < 1e-10);
    assert.deepStrictEqual(result.components, { input: 0.13999999999999999, cached: 0.004, write: 0.024999999999999998, output: 0.12 });
    assert.strictEqual(estimateModelCost(catalog, model, { ...tokens, input: 0, cached: 0, write: 0, output: 0 }, now).usd, 0);
  });

  test("switches to long-context rates only above the input threshold", () => {
    const catalog = parseModelCatalog(fixture());
    const model = catalog.models.find(model => model.name === "GPT-5.6 Terra")!;
    assert.strictEqual(estimateModelCost(catalog, model, { ...tokens, input: 272000 }, now).tier, "default");
    const result = estimateModelCost(catalog, model, { ...tokens, input: 272001 }, now);
    assert.strictEqual(result.tier, "long");
    assert.ok(Math.abs(result.components.output - 0.18) < 1e-10);
  });

  test("applies eligible Auto and Max discounts and expires the Max promotion", () => {
    const catalog = parseModelCatalog(fixture());
    const model = catalog.models.find(model => model.name === "GPT-5.6 Terra")!;
    assert.strictEqual(estimateModelCost(catalog, model, { ...tokens, mode: "auto" }, now).discount, 0.1);
    assert.strictEqual(estimateModelCost(catalog, model, { ...tokens, mode: "max-auto" }, new Date("2026-10-28T23:59:59Z")).discount, 0.3);
    assert.strictEqual(estimateModelCost(catalog, model, { ...tokens, mode: "max-auto" }, new Date("2026-10-29T00:00:00Z")).discount, 0.1);
  });

  test("rejects invalid tokens, unpublished cache writes, legacy billing and unsupported discounts", () => {
    const catalog = parseModelCatalog(fixture());
    const model = catalog.models[0];
    const clean = { ...tokens, write: 0 };
    for (const amount of [-1, 1.1, NaN, Infinity, 1e12 + 1]) {
      assert.throws(() => estimateModelCost(catalog, model, { ...clean, input: amount }, now));
    }
    assert.throws(() => estimateModelCost(catalog, model, { ...clean, cached: clean.input + 1 }, now));
    assert.throws(() => estimateModelCost(catalog, model, tokens, now), /cache-write/);
    assert.throws(() => estimateModelCost(catalog, catalog.models.find(model => model.access === "annual")!, clean, now), /annual/);
    assert.throws(() => estimateModelCost(catalog, catalog.models.find(model => model.access === "extension")!, { ...clean, mode: "auto" }, now), /Auto/);
  });

  test("blocks expired model promotions at the UTC day boundary and flags stale data", () => {
    const catalog = parseModelCatalog(fixture());
    const model = catalog.models.find(model => model.name === "Gemini 4 Argon")!;
    assert.strictEqual(isExpired(model.validUntil, new Date("2026-11-30T23:59:59Z")), false);
    assert.strictEqual(isExpired(model.validUntil, new Date("2026-12-01T00:00:00Z")), true);
    assert.throws(() => estimateModelCost(catalog, model, { ...tokens, write: 0 }, new Date("2026-12-01")), /expired/);
    assert.strictEqual(isCatalogStale(catalog, now), false);
    assert.strictEqual(isCatalogStale(catalog, new Date("2026-12-01")), true);
  });
});