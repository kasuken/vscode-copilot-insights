import { CopilotUserData, LocalSnapshot } from "../types";
import { findPremiumQuota, getEffectiveQuota } from "./quota";

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
