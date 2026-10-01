import {
  CopilotUserData,
  CREDIT_COST_USD,
  DailyRollup,
  LocalSnapshot,
  QuotaSnapshot,
} from "../types";
import { findPremiumQuota, getEffectiveQuota } from "./quota";
import { localDateKey } from "./rollups";

/**
 * Estimated billing rate for premium requests consumed beyond the plan
 * entitlement (overage), in USD per credit. Kept in sync with the rate
 * used elsewhere in the extension.
 */
export const OVERAGE_COST_PER_CREDIT_USD = CREDIT_COST_USD;

/**
 * Where a usage estimate's data points came from. `rollups` means whole
 * observed days (the durable tier); `snapshots` means raw interval pairs, used
 * only until at least two complete days have been rolled up.
 */
export type UsageDataSource = "rollups" | "snapshots";

export interface WeightedPrediction {
  predictedDailyUsage: number;
  confidence: "low" | "medium" | "high";
  confidenceReason: string;
  daysUntilExhaustion: number | null;
  willExhaustBeforeReset: boolean;
  dataPoints: number;
  source: UsageDataSource;
}

export interface TrendPrediction {
  recentBurnRate: number;
  overallBurnRate: number;
  trend: "accelerating" | "slowing" | "stable";
  trendIndicator: string;
  dataPoints: number;
  source: UsageDataSource;
}

/**
 * Extracts normalized daily-usage data points from consecutive snapshot pairs.
 * Only pairs between 1 and 72 hours apart with positive consumption count.
 */
function getDailyUsageData(history: readonly LocalSnapshot[]): { usage: number; timestamp: Date }[] {
  const usageData: { usage: number; timestamp: Date }[] = [];

  for (let i = 0; i < history.length - 1; i++) {
    const current = history[i];
    const previous = history[i + 1];

    const currentTime = new Date(current.timestamp);
    const previousTime = new Date(previous.timestamp);

    // Calculate time difference in hours
    const hoursDiff = (currentTime.getTime() - previousTime.getTime()) / (1000 * 60 * 60);

    // Only consider if time difference is reasonable (between 1 hour and 72 hours)
    if (hoursDiff >= 1 && hoursDiff <= 72) {
      const usage = previous.premium_remaining - current.premium_remaining;

      // Only include positive usage (actual consumption)
      if (usage > 0) {
        // Normalize to daily usage
        const dailyUsage = (usage / hoursDiff) * 24;
        usageData.push({ usage: dailyUsage, timestamp: currentTime });
      }
    }
  }

  return usageData;
}

/**
 * Daily usage points from rollups: one per completed day that recorded usage.
 *
 * This is the preferred source. {@link getDailyUsageData} can only use raw
 * snapshot pairs between 1 and 72 hours apart, so an active session — which
 * records a snapshot every polling interval — leaves it with almost nothing to
 * work with, and the heavier the usage the fewer points survive. Rollups are
 * one point per day by construction, so accuracy now improves with usage
 * instead of collapsing.
 *
 * Today is excluded: it is still accumulating and would drag the average down.
 * Days with no recorded usage are excluded too, matching the snapshot-based
 * behaviour, which keeps the estimate conservative.
 */
export function getDailyUsageFromRollups(
  rollups: readonly DailyRollup[],
  now = new Date()
): { usage: number; timestamp: Date }[] {
  const today = localDateKey(now);
  const usageData: { usage: number; timestamp: Date }[] = [];

  // Rollups are ascending by date; predictions elsewhere assume newest first.
  for (let i = rollups.length - 1; i >= 0; i--) {
    const rollup = rollups[i];
    if (rollup.date >= today || rollup.used <= 0) {
      continue;
    }
    // Midday anchors the point away from DST boundaries.
    const timestamp = new Date(`${rollup.date}T12:00:00`);
    if (isNaN(timestamp.getTime())) {
      continue;
    }
    usageData.push({ usage: rollup.used, timestamp });
  }

  return usageData;
}

/** Minimum complete days before rollups are preferred over raw snapshots. */
const MIN_ROLLUP_DAYS = 2;

/**
 * Picks the best available usage series: rollups once enough complete days
 * exist, otherwise the raw snapshot pairs (which is all a fresh install has).
 */
function selectUsageData(
  history: readonly LocalSnapshot[],
  rollups: readonly DailyRollup[],
  now?: Date
): { usageData: { usage: number; timestamp: Date }[]; source: UsageDataSource } {
  const fromRollups = getDailyUsageFromRollups(rollups, now);
  if (fromRollups.length >= MIN_ROLLUP_DAYS) {
    return { usageData: fromRollups, source: "rollups" };
  }

  const fromSnapshots = getDailyUsageData(history);
  if (fromSnapshots.length > fromRollups.length) {
    return { usageData: fromSnapshots, source: "snapshots" };
  }

  return { usageData: fromRollups, source: "rollups" };
}

export function getWeightedPrediction(
  history: readonly LocalSnapshot[],
  data: CopilotUserData,
  customLimit: number,
  rollups: readonly DailyRollup[] = []
): WeightedPrediction | null {
  if (history.length < 2 && rollups.length === 0) {
    return null;
  }

  const { usageData, source } = selectUsageData(history, rollups);

  if (usageData.length === 0) {
    return null;
  }

  // Calculate average daily usage from all data points
  const predictedDailyUsage = usageData.reduce((sum, d) => sum + d.usage, 0) / usageData.length;

  // Determine confidence level based on number of data points
  let confidence: "low" | "medium" | "high";
  let confidenceReason: string;
  const totalDataPoints = usageData.length;

  if (totalDataPoints >= 7) {
    confidence = "high";
    confidenceReason = `Based on ${totalDataPoints} data points from local history`;
  } else if (totalDataPoints >= 3) {
    confidence = "medium";
    confidenceReason = `Based on ${totalDataPoints} data points from local history`;
  } else {
    confidence = "low";
    confidenceReason = `Limited data: only ${totalDataPoints} data point${totalDataPoints > 1 ? "s" : ""} available`;
  }

  // Calculate days until exhaustion
  const premiumQuota = findPremiumQuota(data.quota_snapshots);

  let daysUntilExhaustion: number | null = null;
  let willExhaustBeforeReset = false;

  if (premiumQuota && !premiumQuota.unlimited && predictedDailyUsage > 0) {
    const effectiveQ = getEffectiveQuota(premiumQuota, customLimit);
    daysUntilExhaustion = Math.floor(effectiveQ.remaining / predictedDailyUsage);

    // Check if it will exhaust before reset
    const today = new Date();
    const resetDate = new Date(data.quota_reset_date_utc);
    const daysUntilReset = (resetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);

    willExhaustBeforeReset = daysUntilExhaustion < daysUntilReset;
  }

  return {
    predictedDailyUsage: Math.round(predictedDailyUsage),
    confidence,
    confidenceReason,
    daysUntilExhaustion,
    willExhaustBeforeReset,
    dataPoints: totalDataPoints,
    source,
  };
}

export interface OverageEstimate {
  /** Credits already consumed beyond the plan entitlement. */
  currentOverageCredits: number;
  /** Estimated cost of the current overage in USD. */
  currentOverageCostUsd: number;
  /**
   * Total overage credits projected by the end of the billing cycle
   * (current overage plus projected future overage), or null when no
   * usage prediction is available.
   */
  projectedOverageCredits: number | null;
  /** Estimated cost of the projected overage in USD, or null. */
  projectedOverageCostUsd: number | null;
  /** Days remaining until the quota reset (fractional, clamped at 0). */
  daysUntilReset: number;
}

/**
 * Estimates current and projected overage for a metered quota during the
 * current billing cycle. Returns null when the quota is unlimited or when
 * overage is neither permitted nor already incurred (nothing to show).
 *
 * `predictedDailyUsage` comes from {@link getWeightedPrediction}; pass null
 * when no prediction is available to skip the projection.
 */
export function estimateOverage(
  quota: QuotaSnapshot,
  predictedDailyUsage: number | null,
  resetDateUtc: string,
  now = new Date()
): OverageEstimate | null {
  if (quota.unlimited) {
    return null;
  }

  // Current overage: prefer the API-reported count; fall back to how far
  // `remaining` has gone below zero.
  const currentOverageCredits = Math.max(
    quota.overage_count > 0 ? quota.overage_count : 0,
    quota.remaining < 0 ? -quota.remaining : 0
  );

  if (!quota.overage_permitted && currentOverageCredits <= 0) {
    return null;
  }

  const resetTime = new Date(resetDateUtc).getTime();
  const daysUntilReset = Number.isFinite(resetTime)
    ? Math.max(0, (resetTime - now.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  let projectedOverageCredits: number | null = null;
  if (predictedDailyUsage !== null && predictedDailyUsage > 0 && daysUntilReset > 0) {
    const projectedUsage = predictedDailyUsage * daysUntilReset;
    const remainingCredits = Math.max(0, quota.remaining);
    const futureOverage = Math.max(0, projectedUsage - remainingCredits);
    projectedOverageCredits = parseFloat((currentOverageCredits + futureOverage).toFixed(1));
  }

  return {
    currentOverageCredits: parseFloat(currentOverageCredits.toFixed(1)),
    currentOverageCostUsd: parseFloat((currentOverageCredits * OVERAGE_COST_PER_CREDIT_USD).toFixed(2)),
    projectedOverageCredits,
    projectedOverageCostUsd: projectedOverageCredits !== null
      ? parseFloat((projectedOverageCredits * OVERAGE_COST_PER_CREDIT_USD).toFixed(2))
      : null,
    daysUntilReset,
  };
}

/**
 * Computes forecast points for the history chart: a straight line from the
 * current remaining balance declining at `predictedDailyUsage` per day until
 * the reset date, clamped at 0. When the balance would hit zero before the
 * reset, an intermediate zero-crossing point is included so the line stays
 * flat at 0 afterwards. Returns an empty array when the inputs cannot
 * produce a meaningful forecast.
 */
export function computeForecastPoints(
  startTimeMs: number,
  startRemaining: number,
  predictedDailyUsage: number,
  resetTimeMs: number
): { x: number; y: number }[] {
  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(resetTimeMs) ||
    resetTimeMs <= startTimeMs ||
    !(predictedDailyUsage > 0) ||
    startRemaining < 0
  ) {
    return [];
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const remainingAtReset = startRemaining - predictedDailyUsage * ((resetTimeMs - startTimeMs) / msPerDay);

  if (remainingAtReset < 0) {
    const zeroTime = startTimeMs + (startRemaining / predictedDailyUsage) * msPerDay;
    return [
      { x: startTimeMs, y: startRemaining },
      { x: zeroTime, y: 0 },
      { x: resetTimeMs, y: 0 },
    ];
  }

  return [
    { x: startTimeMs, y: startRemaining },
    { x: resetTimeMs, y: remainingAtReset },
  ];
}

export function getTrendPrediction(
  history: readonly LocalSnapshot[],
  rollups: readonly DailyRollup[] = []
): TrendPrediction | null {
  if (history.length < 3 && rollups.length === 0) {
    return null;
  }

  const { usageData, source } = selectUsageData(history, rollups);

  if (usageData.length < 2) {
    return null;
  }

  // Calculate overall average burn rate
  const overallBurnRate = usageData.reduce((sum, d) => sum + d.usage, 0) / usageData.length;

  // Calculate recent burn rate (last 50% of data or minimum 2 points)
  const recentCount = Math.max(2, Math.ceil(usageData.length / 2));
  const recentData = usageData.slice(0, recentCount);
  const recentBurnRate = recentData.reduce((sum, d) => sum + d.usage, 0) / recentData.length;

  // Determine trend
  const difference = recentBurnRate - overallBurnRate;
  const percentDiff = overallBurnRate > 0 ? (difference / overallBurnRate) * 100 : 0;

  let trend: "accelerating" | "slowing" | "stable";
  let trendIndicator: string;

  if (Math.abs(percentDiff) < 10) {
    trend = "stable";
    trendIndicator = "No significant change";
  } else if (difference > 0) {
    trend = "accelerating";
    trendIndicator = `+${Math.round(Math.abs(percentDiff))}% vs average`;
  } else {
    trend = "slowing";
    trendIndicator = `-${Math.round(Math.abs(percentDiff))}% vs average`;
  }

  return {
    recentBurnRate: Math.round(recentBurnRate),
    overallBurnRate: Math.round(overallBurnRate),
    trend,
    trendIndicator,
    dataPoints: usageData.length,
    source,
  };
}
