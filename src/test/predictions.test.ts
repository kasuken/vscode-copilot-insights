import * as assert from "assert";
import { getTrendPrediction, getWeightedPrediction } from "../core/predictions";
import { CopilotUserData, LocalSnapshot } from "../types";
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
