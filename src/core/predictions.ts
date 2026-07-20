import { CopilotUserData, CREDIT_COST_USD, LocalSnapshot, QuotaSnapshot } from "../types";
import { findPremiumQuota, getEffectiveQuota } from "./quota";

/**
 * Estimated billing rate for premium requests consumed beyond the plan
 * entitlement (overage), in USD per credit. Kept in sync with the rate
 * used elsewhere in the extension.
 */
export const OVERAGE_COST_PER_CREDIT_USD = CREDIT_COST_USD;

export interface WeightedPrediction {
  predictedDailyUsage: number;
  confidence: "low" | "medium" | "high";
  confidenceReason: string;
  daysUntilExhaustion: number | null;
  willExhaustBeforeReset: boolean;
  dataPoints: number;
}

export interface TrendPrediction {
  recentBurnRate: number;
  overallBurnRate: number;
  trend: "accelerating" | "slowing" | "stable";
  trendIndicator: string;
  dataPoints: number;
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

export function getWeightedPrediction(
  history: readonly LocalSnapshot[],
  data: CopilotUserData,
  customLimit: number
): WeightedPrediction | null {
  if (history.length < 2) {
    return null;
  }

  const usageData = getDailyUsageData(history);

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

export function getTrendPrediction(history: readonly LocalSnapshot[]): TrendPrediction | null {
  if (history.length < 3) {
    return null;
  }

  const usageData = getDailyUsageData(history);

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
  };
}
