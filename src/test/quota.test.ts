import * as assert from "assert";
import {
  calculateDaysUntilReset,
  computeQuotaStats,
  findPremiumQuota,
  getEffectiveQuota,
  getMood,
  getStatusBadge,
  normalizePollingIntervalSeconds,
} from "../core/quota";
import { QuotaSnapshot } from "../types";

export function makeQuota(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    quota_id: "premium_interactions",
    timestamp_utc: "2026-07-01T00:00:00Z",
    entitlement: 300,
    quota_remaining: 120,
    remaining: 120,
    percent_remaining: 40,
    unlimited: false,
    overage_permitted: false,
    overage_count: 0,
    ...overrides,
  };
}

suite("normalizePollingIntervalSeconds", () => {
  test("returns default fallback for undefined", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(undefined), 60);
  });

  test("returns custom fallback for undefined", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(undefined, 120), 120);
  });

  test("returns fallback for NaN/Infinity", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(NaN), 60);
    assert.strictEqual(normalizePollingIntervalSeconds(Infinity), 60);
  });

  test("returns 0 for zero and negative values (polling disabled)", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(0), 0);
    assert.strictEqual(normalizePollingIntervalSeconds(-5), 0);
  });

  test("rounds values and clamps small positives to 1", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(0.4), 1);
    assert.strictEqual(normalizePollingIntervalSeconds(90.6), 91);
  });
});

suite("getEffectiveQuota", () => {
  test("returns original quota when custom limit is 0", () => {
    const quota = makeQuota();
    const eq = getEffectiveQuota(quota, 0);
    assert.deepStrictEqual(eq, quota);
  });

  test("returns original quota when custom limit is at or below plan", () => {
    const quota = makeQuota();
    assert.deepStrictEqual(getEffectiveQuota(quota, 300), quota);
    assert.deepStrictEqual(getEffectiveQuota(quota, 100), quota);
  });

  test("applies custom limit above plan entitlement", () => {
    // 180 used of 300 plan; custom limit 500 -> 320 effective remaining
    const eq = getEffectiveQuota(makeQuota(), 500);
    assert.strictEqual(eq.entitlement, 500);
    assert.strictEqual(eq.remaining, 320);
    assert.strictEqual(eq.quota_remaining, 320);
  });

  test("custom limit when plan is exhausted", () => {
    const quota = makeQuota({ quota_remaining: 0, remaining: -50 });
    const eq = getEffectiveQuota(quota, 500);
    // used = plan entitlement (300); remaining tracks distance from custom cap
    assert.strictEqual(eq.entitlement, 500);
    assert.strictEqual(eq.remaining, 200);
  });
});

suite("computeQuotaStats", () => {
  test("computes stats for normal usage", () => {
    const stats = computeQuotaStats(makeQuota());
    assert.strictEqual(stats.used, 180);
    assert.strictEqual(stats.isOverQuota, false);
    assert.strictEqual(stats.percentRemaining, 40);
    assert.strictEqual(stats.percentUsed, 60);
    assert.strictEqual(stats.overageAmount, 0);
  });

  test("computes stats when over quota", () => {
    const stats = computeQuotaStats(makeQuota({ quota_remaining: 0, remaining: -25.5 }));
    assert.strictEqual(stats.isOverQuota, true);
    assert.strictEqual(stats.overageAmount, 25.5);
    assert.strictEqual(stats.percentUsed, 100);
    assert.strictEqual(stats.percentRemaining, 0);
  });

  test("rounds percentages to one decimal", () => {
    const stats = computeQuotaStats(makeQuota({ quota_remaining: 100, remaining: 100 }));
    assert.strictEqual(stats.percentRemaining, 33.3);
    assert.strictEqual(stats.percentUsed, 66.7);
  });
});

suite("calculateDaysUntilReset", () => {
  test("computes days and hours", () => {
    const result = calculateDaysUntilReset(
      "2026-07-11T12:00:00Z",
      "2026-07-01T00:00:00Z"
    );
    assert.strictEqual(result.days, 10);
    assert.strictEqual(result.hours, 12);
    assert.ok(Math.abs(result.totalDays - 10.5) < 0.001);
  });

  test("returns negative totalDays after the reset date", () => {
    const result = calculateDaysUntilReset(
      "2026-07-01T00:00:00Z",
      "2026-07-02T00:00:00Z"
    );
    assert.ok(result.totalDays < 0);
  });
});

suite("getStatusBadge", () => {
  test("over quota", () => {
    const badge = getStatusBadge(0, true);
    assert.strictEqual(badge.label, "Over Quota");
    assert.strictEqual(badge.icon, "$(error)");
  });

  test("over quota without coloring uses neutral icon", () => {
    const badge = getStatusBadge(-5, false);
    assert.strictEqual(badge.icon, "$(circle-slash)");
  });

  test("healthy above 50%", () => {
    assert.strictEqual(getStatusBadge(51, true).label, "Healthy");
  });

  test("watch between 20% and 50%", () => {
    assert.strictEqual(getStatusBadge(20, true).label, "Watch");
    assert.strictEqual(getStatusBadge(50, true).label, "Watch");
  });

  test("risk below 20%", () => {
    assert.strictEqual(getStatusBadge(19.9, true).label, "Risk");
  });
});

suite("getMood", () => {
  test("mood tiers", () => {
    assert.strictEqual(getMood(0).text, "Over quota");
    assert.strictEqual(getMood(80).text, "Plenty of quota left");
    assert.strictEqual(getMood(50).text, "You’re fine");
    assert.strictEqual(getMood(20).text, "Getting tight");
    assert.strictEqual(getMood(10).text, "Danger zone");
  });
});

suite("findPremiumQuota", () => {
  test("finds premium_interactions quota", () => {
    const premium = makeQuota();
    const chat = makeQuota({ quota_id: "chat", unlimited: true });
    const result = findPremiumQuota({ chat, premium_interactions: premium });
    assert.strictEqual(result?.quota_id, "premium_interactions");
  });

  test("returns undefined when missing", () => {
    assert.strictEqual(findPremiumQuota({}), undefined);
    assert.strictEqual(findPremiumQuota(undefined), undefined);
  });
});
