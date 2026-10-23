export const MODEL_CATALOG_URL = "https://www.emanuelebartolesi.com/resources/github-copilot.json";
export const MAX_CATALOG_BYTES = 512 * 1024;

export interface TokenRates {
  input: number;
  cached: number;
  write: number | null;
  output: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  access: string;
  rates: TokenRates;
  longContext?: TokenRates;
  threshold?: number;
  note?: string;
  validUntil?: string;
}

export interface CatalogPlan {
  name: string;
  audience: string;
  monthly: number;
  base: number;
  flex: number | null;
  models: string;
  ownership: string;
  management: string;
  extra: string;
  training: string;
}

export interface ModelCatalog {
  schemaVersion: 1;
  revision: string;
  reviewedAt: string;
  currency: "USD";
  tokensPerUnit: 1000000;
  creditCostUsd: 0.01;
  sources: Record<string, { title: string; url: string }>;
  models: CatalogModel[];
  access: Record<string, string>;
  notes: Record<string, string>;
  groups: { name: string; examples: string }[];
  guidance: { task: string; fits: string[] }[];
  plans: CatalogPlan[];
  selectionOptions: { name: string; behavior: string; use: string }[];
  autoTiers: { name: string; priority: string; use: string }[];
  hydraPatterns: { name: string; behavior: string }[];
  billingRules: {
    autoDiscount: number;
    autoDiscountAccess: string[];
    maxAutoDiscount: number;
    maxAutoDiscountUntil: string;
    reviewedAt: string;
    hydraFusion: string;
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Expected an object"); }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) { throw new Error("Invalid catalog text"); }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) { throw new Error("Invalid catalog number"); }
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 500) { throw new Error("Invalid catalog list"); }
  return value;
}

function date(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) {
    throw new Error("Invalid catalog date");
  }
  return result;
}

export function isCatalogSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["docs.github.com", "github.blog", "www.emanuelebartolesi.com"].includes(url.hostname);
  } catch { return false; }
}

function rates(value: unknown): TokenRates {
  const row = object(value);
  return { input: number(row.input), cached: number(row.cached), write: row.write === null ? null : number(row.write), output: number(row.output) };
}

function strings(value: unknown): Record<string, string> {
  const entries = Object.entries(object(value));
  if (entries.length > 100) { throw new Error("Too many catalog labels"); }
  return Object.fromEntries(entries.map(([key, label]) => [text(key), text(label)]));
}

export function parseModelCatalog(value: unknown): ModelCatalog {
  const root = object(value);
  if (root.schemaVersion !== 1 || root.currency !== "USD" || root.tokensPerUnit !== 1000000 || root.creditCostUsd !== 0.01) {
    throw new Error("Unsupported catalog schema or billing units");
  }
  const access = strings(root.access);
  const notes = strings(root.notes);
  const models = list(root.models).map((value): CatalogModel => {
    const row = object(value);
    const model: CatalogModel = { id: text(row.id), name: text(row.name), provider: text(row.provider), access: text(row.access), rates: rates(row.rates) };
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model.id) || !Object.hasOwn(access, model.access)) { throw new Error("Invalid model identity or access"); }
    if (row.note !== undefined) {
      model.note = text(row.note);
      if (!Object.hasOwn(notes, model.note)) { throw new Error("Unknown model note"); }
    }
    if (row.longContext !== undefined) {
      model.longContext = rates(row.longContext);
      model.threshold = number(row.threshold);
      if (!Number.isSafeInteger(model.threshold) || model.threshold === 0) { throw new Error("Invalid context threshold"); }
    } else if (row.threshold !== undefined) { throw new Error("Threshold without a long-context rate"); }
    if (row.validUntil !== undefined) { model.validUntil = date(row.validUntil); }
    return model;
  });
  if (!models.length || new Set(models.map(model => model.id)).size !== models.length) { throw new Error("Empty catalog or duplicate model IDs"); }
  const sourceEntries = Object.entries(object(root.sources));
  if (!sourceEntries.length || sourceEntries.length > 100) { throw new Error("Invalid sources"); }
  const sources = Object.fromEntries(sourceEntries.map(([key, value]) => {
    const row = object(value);
    const url = text(row.url);
    if (!isCatalogSourceUrl(url)) { throw new Error("Untrusted source URL"); }
    return [text(key), { title: text(row.title), url }];
  }));
  if (!sources.pricing || !sources.models || !sources.auto) { throw new Error("Missing billing sources"); }
  const groups = list(root.groups).map(value => {
    const row = object(value);
    return { name: text(row.name), examples: text(row.examples) };
  });
  const guidance = list(root.guidance).map(value => {
    const row = object(value);
    const fits = list(row.fits).map(text);
    if (fits.length !== groups.length || fits.some(fit => !["Start here", "Also fits", "Not first choice"].includes(fit))) {
      throw new Error("Invalid task guidance");
    }
    return { task: text(row.task), fits };
  });
  const plans = list(root.plans).map((value): CatalogPlan => {
    const row = object(value);
    return { name: text(row.name), audience: text(row.audience), monthly: number(row.monthly), base: number(row.base),
      flex: row.flex === null ? null : number(row.flex), models: text(row.models), ownership: text(row.ownership),
      management: text(row.management), extra: text(row.extra), training: text(row.training) };
  });
  const selectionOptions = list(root.selectionOptions).map(value => {
    const row = object(value);
    return { name: text(row.name), behavior: text(row.behavior), use: text(row.use) };
  });
  const autoTiers = list(root.autoTiers).map(value => {
    const row = object(value);
    return { name: text(row.name), priority: text(row.priority), use: text(row.use) };
  });
  const hydraPatterns = list(root.hydraPatterns).map(value => {
    const row = object(value);
    return { name: text(row.name), behavior: text(row.behavior) };
  });
  const rules = object(root.billingRules);
  const autoDiscount = number(rules.autoDiscount);
  const maxAutoDiscount = number(rules.maxAutoDiscount);
  const autoDiscountAccess = list(rules.autoDiscountAccess).map(text);
  if (autoDiscount >= 1 || maxAutoDiscount >= 1 || autoDiscountAccess.some(key => !Object.hasOwn(access, key))) {
    throw new Error("Invalid discount rule");
  }
  return { schemaVersion: 1, revision: text(root.revision), reviewedAt: date(root.reviewedAt), currency: "USD",
    tokensPerUnit: 1000000, creditCostUsd: 0.01, sources, models, access, notes, groups, guidance, plans,
    selectionOptions, autoTiers, hydraPatterns,
    billingRules: { autoDiscount, autoDiscountAccess, maxAutoDiscount, maxAutoDiscountUntil: date(rules.maxAutoDiscountUntil),
      reviewedAt: date(rules.reviewedAt), hydraFusion: text(rules.hydraFusion) } };
}

export function isExpired(validUntil: string | undefined, now = new Date()): boolean {
  return !!validUntil && now.getTime() >= Date.parse(validUntil) + 86400000;
}

export function isCatalogStale(catalog: ModelCatalog, now = new Date()): boolean {
  return now.getTime() - Date.parse(catalog.reviewedAt) > 30 * 86400000;
}

export interface TokenEstimateInput {
  input: number;
  cached: number;
  write: number;
  output: number;
  mode: "standard" | "auto" | "max-auto";
}

export function estimateModelCost(catalog: ModelCatalog, model: CatalogModel, tokens: TokenEstimateInput, now = new Date()) {
  for (const amount of [tokens.input, tokens.cached, tokens.write, tokens.output]) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e12) { throw new Error("Token counts must be nonnegative whole numbers up to 1 trillion."); }
  }
  if (tokens.cached + tokens.write > tokens.input) { throw new Error("Cached input and cache writes cannot exceed total input tokens."); }
  if (isExpired(model.validUntil, now)) { throw new Error("These promotional rates have expired. Refresh the catalog or check the official source."); }
  if (!["standard", "auto", "max-auto"].includes(tokens.mode)) { throw new Error("Unknown billing mode."); }
  if (model.access === "annual") { throw new Error("Legacy annual request billing cannot be estimated from token rates."); }
  const tier = model.longContext && tokens.input > model.threshold! ? "long" : "default";
  const rate = tier === "long" ? model.longContext! : model.rates;
  if (tokens.write > 0 && rate.write === null) { throw new Error("No separate cache-write rate is published for this model."); }
  const rules = catalog.billingRules;
  if (tokens.mode !== "standard" && !rules.autoDiscountAccess.includes(model.access)) { throw new Error("Auto discounts are not supported for this access category."); }
  const discount = tokens.mode === "standard" ? 0 : tokens.mode === "max-auto" && !isExpired(rules.maxAutoDiscountUntil, now)
    ? rules.maxAutoDiscount : rules.autoDiscount;
  const factor = (1 - discount) / catalog.tokensPerUnit;
  const components = {
    input: (tokens.input - tokens.cached - tokens.write) * rate.input * factor,
    cached: tokens.cached * rate.cached * factor,
    write: tokens.write * (rate.write ?? 0) * factor,
    output: tokens.output * rate.output * factor,
  };
  const usd = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { usd, credits: usd / catalog.creditCostUsd, components, discount, tier };
}