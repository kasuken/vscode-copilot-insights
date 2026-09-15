import * as assert from "assert";
import {
  computeForecastPoints,
  estimateOverage,
  getDailyUsageFromRollups,
  getTrendPrediction,
  getWeightedPrediction,
  OVERAGE_COST_PER_CREDIT_USD,
} from "../core/predictions";
import { CopilotUserData, DailyRollup, LocalSnapshot } from "../types";
import { makeQuota } from "./quota.test";

/**
 * Builds a newest-first snapshot history. `remainingValues[0]` is the most
 * recent value; each entry is `gapHours` older than the previous one.
 */
function makeHistory(remainingValues: number[], gapHours = 12, entitlement = 300): LocalSnapshot[] {
  const now = Date.now();
  return remainingValues.map((remaining, i) => ({
    timestamp: new Date(now - i * gapHours * 60 * 60 * 1000).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: entitlement,
  }));
}

function makeUserData(overrides: Partial<CopilotUserData> = {}): CopilotUserData {
  const resetInTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  return {
    login: "octocat",
    copilot_plan: "Pro",
    chat_enabled: true,
    cli_enabled: true,
    is_mcp_enabled: true,
    editor_preview_features_enabled: true,
    copilotignore_enabled: false,
    restricted_telemetry: false,
    access_type_sku: "pro",
    assigned_date: "2025-01-01T00:00:00Z",
    organization_list: [],
    quota_snapshots: {
      premium_interactions: makeQuota({ quota_remaining: 100, remaining: 100 }),
    },
    quota_reset_date_utc: resetInTenDays,
    quota_reset_date: resetInTenDays,
    ...overrides,
  };
}

suite("getWeightedPrediction", () => {
  test("returns null with fewer than 2 snapshots", () => {
    assert.strictEqual(getWeightedPrediction(makeHistory([100]), makeUserData(), 0), null);
  });

  test("computes daily usage from consecutive snapshots", () => {
    // 30 credits over 12 hours -> 60/day
    const prediction = getWeightedPrediction(makeHistory([100, 130]), makeUserData(), 0);
    assert.ok(prediction);
    assert.strictEqual(prediction.predictedDailyUsage, 60);
    assert.strictEqual(prediction.confidence, "low");
    assert.strictEqual(prediction.dataPoints, 1);
  });

  test("estimates exhaustion before reset", () => {
    // 60/day burn with 100 remaining -> exhausted in 1 day, reset in ~10 days
    const prediction = getWeightedPrediction(makeHistory([100, 130]), makeUserData(), 0);
    assert.ok(prediction);
    assert.strictEqual(prediction.daysUntilExhaustion, 1);
    assert.strictEqual(prediction.willExhaustBeforeReset, true);
  });

  test("confidence tiers scale with data points", () => {
    // 4 points -> 3 usage pairs -> medium
    const medium = getWeightedPrediction(makeHistory([100, 120, 140, 160]), makeUserData(), 0);
    assert.strictEqual(medium?.confidence, "medium");

    // 8 points -> 7 usage pairs -> high
    const high = getWeightedPrediction(
      makeHistory([100, 120, 140, 160, 180, 200, 220, 240]),
      makeUserData(),
      0
    );
    assert.strictEqual(high?.confidence, "high");
  });

  test("ignores gaps outside the 1-72 hour window", () => {
    // 100h gap -> excluded -> no usable data
    const prediction = getWeightedPrediction(makeHistory([100, 200], 100), makeUserData(), 0);
    assert.strictEqual(prediction, null);
  });

  test("ignores non-positive usage (quota resets)", () => {
    // remaining increased -> reset happened -> not consumption
    const prediction = getWeightedPrediction(makeHistory([300, 50]), makeUserData(), 0);
    assert.strictEqual(prediction, null);
  });
});

suite("getTrendPrediction", () => {
  test("returns null with fewer than 3 snapshots", () => {
    assert.strictEqual(getTrendPrediction(makeHistory([100, 130])), null);
  });

  test("detects stable usage", () => {
    const trend = getTrendPrediction(makeHistory([100, 120, 140, 160]));
    assert.strictEqual(trend?.trend, "stable");
    assert.strictEqual(trend?.recentBurnRate, 40);
    assert.strictEqual(trend?.overallBurnRate, 40);
  });

  test("detects accelerating usage", () => {
    // usage pairs (newest first): 60, 20, 20 -> recent avg well above overall
    const trend = getTrendPrediction(makeHistory([100, 160, 180, 200]));
    assert.strictEqual(trend?.trend, "accelerating");
  });

  test("detects slowing usage", () => {
    // usage pairs (newest first): 10, 30, 30 -> recent avg below overall
    const trend = getTrendPrediction(makeHistory([100, 110, 140, 170]));
    assert.strictEqual(trend?.trend, "slowing");
  });
});

suite("estimateOverage", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-07-01T00:00:00Z");
  const resetInTenDays = new Date(now.getTime() + 10 * DAY_MS).toISOString();

  test("returns null for unlimited quotas", () => {
    const quota = makeQuota({ unlimited: true, overage_permitted: true });
    assert.strictEqual(estimateOverage(quota, 10, resetInTenDays, now), null);
  });

  test("returns null when overage is neither permitted nor incurred", () => {
    const quota = makeQuota({ overage_permitted: false, overage_count: 0, remaining: 120 });
    assert.strictEqual(estimateOverage(quota, 10, resetInTenDays, now), null);
  });

  test("reports current overage from the API-reported count", () => {
    const quota = makeQuota({ overage_permitted: true, overage_count: 25, remaining: 0, quota_remaining: 0 });
    const estimate = estimateOverage(quota, null, resetInTenDays, now);
    assert.ok(estimate);
    assert.strictEqual(estimate.currentOverageCredits, 25);
    assert.strictEqual(estimate.currentOverageCostUsd, 25 * OVERAGE_COST_PER_CREDIT_USD);
    assert.strictEqual(estimate.projectedOverageCredits, null);
    assert.strictEqual(estimate.projectedOverageCostUsd, null);
  });

  test("falls back to negative remaining for current overage", () => {
    const quota = makeQuota({ overage_permitted: true, overage_count: 0, remaining: -12, quota_remaining: 0 });
    const estimate = estimateOverage(quota, null, resetInTenDays, now);
    assert.ok(estimate);
    assert.strictEqual(estimate.currentOverageCredits, 12);
  });

  test("projects future overage from predicted daily usage", () => {
    // 100 remaining, 20/day for 10 days -> 200 used -> 100 overage projected
    const quota = makeQuota({ overage_permitted: true, remaining: 100, quota_remaining: 100 });
    const estimate = estimateOverage(quota, 20, resetInTenDays, now);
    assert.ok(estimate);
    assert.strictEqual(estimate.currentOverageCredits, 0);
    assert.strictEqual(estimate.projectedOverageCredits, 100);
    assert.strictEqual(estimate.projectedOverageCostUsd, parseFloat((100 * OVERAGE_COST_PER_CREDIT_USD).toFixed(2)));
    assert.ok(Math.abs(estimate.daysUntilReset - 10) < 0.001);
  });

  test("adds current overage to the projection when already over", () => {
    // Already 10 over; 5/day for 10 days all lands in overage -> 60 total
    const quota = makeQuota({ overage_permitted: true, remaining: -10, quota_remaining: 0 });
    const estimate = estimateOverage(quota, 5, resetInTenDays, now);
    assert.ok(estimate);
    assert.strictEqual(estimate.currentOverageCredits, 10);
    assert.strictEqual(estimate.projectedOverageCredits, 60);
  });

  test("projects zero overage when usage stays within the entitlement", () => {
    const quota = makeQuota({ overage_permitted: true, remaining: 120, quota_remaining: 120 });
    const estimate = estimateOverage(quota, 5, resetInTenDays, now);
    assert.ok(estimate);
    assert.strictEqual(estimate.projectedOverageCredits, 0);
  });

  test("skips the projection when the reset date is invalid or past", () => {
    const quota = makeQuota({ overage_permitted: true, overage_count: 5, remaining: 0, quota_remaining: 0 });
    const past = new Date(now.getTime() - DAY_MS).toISOString();
    assert.strictEqual(estimateOverage(quota, 10, past, now)?.projectedOverageCredits, null);
    assert.strictEqual(estimateOverage(quota, 10, "not-a-date", now)?.projectedOverageCredits, null);
  });
});

suite("computeForecastPoints", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const start = new Date("2026-07-01T00:00:00Z").getTime();

  test("returns a two-point line when the balance lasts until reset", () => {
    const reset = start + 10 * DAY_MS;
    const points = computeForecastPoints(start, 100, 5, reset);
    assert.deepStrictEqual(points, [
      { x: start, y: 100 },
      { x: reset, y: 50 },
    ]);
  });

  test("clamps at zero with an intermediate zero-crossing point", () => {
    const reset = start + 10 * DAY_MS;
    const points = computeForecastPoints(start, 100, 20, reset);
    assert.strictEqual(points.length, 3);
    assert.deepStrictEqual(points[0], { x: start, y: 100 });
    assert.deepStrictEqual(points[1], { x: start + 5 * DAY_MS, y: 0 });
    assert.deepStrictEqual(points[2], { x: reset, y: 0 });
  });

  test("returns empty for non-positive usage or an invalid window", () => {
    const reset = start + 10 * DAY_MS;
    assert.deepStrictEqual(computeForecastPoints(start, 100, 0, reset), []);
    assert.deepStrictEqual(computeForecastPoints(start, 100, -5, reset), []);
    assert.deepStrictEqual(computeForecastPoints(start, 100, 5, start), []);
    assert.deepStrictEqual(computeForecastPoints(start, 100, 5, start - DAY_MS), []);
    assert.deepStrictEqual(computeForecastPoints(NaN, 100, 5, reset), []);
    assert.deepStrictEqual(computeForecastPoints(start, -1, 5, reset), []);
  });
});

suite("getDailyUsageFromRollups", () => {
  const now = new Date(2026, 8, 10, 15, 0, 0);

  /** A completed-day rollup. */
  function rollup(date: string, used: number): DailyRollup {
    return {
      date,
      used,
      endRemaining: 100,
      entitlement: 300,
      samples: 5,
      blocks: [0, 0, used, 0, 0, 0],
    };
  }

  test("returns one point per completed day", () => {
    const points = getDailyUsageFromRollups(
      [rollup("2026-09-08", 20), rollup("2026-09-09", 30)],
      now
    );

    assert.strictEqual(points.length, 2);
    // Newest first, matching the snapshot-derived series.
    assert.deepStrictEqual(points.map((p) => p.usage), [30, 20]);
  });

  test("excludes today, which is still accumulating", () => {
    const points = getDailyUsageFromRollups(
      [rollup("2026-09-09", 30), rollup("2026-09-10", 2)],
      now
    );

    assert.strictEqual(points.length, 1);
    assert.strictEqual(points[0].usage, 30);
  });

  test("excludes days with no recorded usage", () => {
    const points = getDailyUsageFromRollups(
      [rollup("2026-09-08", 0), rollup("2026-09-09", 30)],
      now
    );

    assert.strictEqual(points.length, 1);
  });
});

suite("predictions from rollups", () => {
  /**
   * Dense history: a snapshot every 5 minutes, which is what an active
   * session produces. Every consecutive pair is under the 1-hour floor that
   * the snapshot-based extraction requires, so it yields nothing on its own.
   */
  function denseHistory(count: number): LocalSnapshot[] {
    const now = Date.now();
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(now - i * 5 * 60 * 1000).toISOString(),
      premium_remaining: 100 + i,
      premium_entitlement: 300,
    }));
  }

  /** Completed-day rollups ending yesterday. */
  function recentRollups(usedPerDay: number[]): DailyRollup[] {
    const today = new Date();
    return usedPerDay.map((used, i) => {
      const day = new Date(today);
      day.setDate(day.getDate() - (usedPerDay.length - i));
      const date = [
        day.getFullYear(),
        `${day.getMonth() + 1}`.padStart(2, "0"),
        `${day.getDate()}`.padStart(2, "0"),
      ].join("-");
      return {
        date,
        used,
        endRemaining: 100,
        entitlement: 300,
        samples: 10,
        blocks: [0, 0, used, 0, 0, 0],
      };
    });
  }

  test("dense snapshot history alone produces no prediction", () => {
    // This is the failure the rollups fix: heavy usage starves the estimate.
    const prediction = getWeightedPrediction(denseHistory(80), makeUserData(), 0);
    assert.strictEqual(prediction, null);
  });

  test("rollups rescue the prediction for the same dense history", () => {
    const prediction = getWeightedPrediction(
      denseHistory(80),
      makeUserData(),
      0,
      recentRollups([20, 30, 40])
    );

    assert.ok(prediction);
    assert.strictEqual(prediction.source, "rollups");
    assert.strictEqual(prediction.predictedDailyUsage, 30);
    assert.strictEqual(prediction.dataPoints, 3);
  });

  test("confidence rises with the number of tracked days", () => {
    const week = getWeightedPrediction(
      denseHistory(10),
      makeUserData(),
      0,
      recentRollups([10, 10, 10, 10, 10, 10, 10])
    );
    const couple = getWeightedPrediction(
      denseHistory(10),
      makeUserData(),
      0,
      recentRollups([10, 10])
    );

    assert.strictEqual(week?.confidence, "high");
    assert.strictEqual(couple?.confidence, "low");
  });

  test("falls back to snapshots until two days are rolled up", () => {
    // Widely spaced snapshots still work on their own.
    const prediction = getWeightedPrediction(
      makeHistory([100, 130, 160], 24),
      makeUserData(),
      0,
      recentRollups([25])
    );

    assert.strictEqual(prediction?.source, "snapshots");
  });

  test("trend analysis reads from rollups too", () => {
    const trend = getTrendPrediction(denseHistory(80), recentRollups([10, 10, 40, 40]));

    assert.ok(trend);
    assert.strictEqual(trend.source, "rollups");
    assert.strictEqual(trend.overallBurnRate, 25);
    // Recent half of the series (newest first) is the two 40-credit days.
    assert.strictEqual(trend.recentBurnRate, 40);
    assert.strictEqual(trend.trend, "accelerating");
  });
});
