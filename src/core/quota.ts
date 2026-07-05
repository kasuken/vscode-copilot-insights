import {
  DEFAULT_POLLING_INTERVAL_SECONDS,
  QuotaSnapshot,
  QuotaStats,
  StatusBadge,
  TimeUntilReset,
} from "../types";

export function normalizePollingIntervalSeconds(
  value: number | undefined,
  fallbackSeconds = DEFAULT_POLLING_INTERVAL_SECONDS
): number {
  const normalizedFallback = Number.isFinite(fallbackSeconds) && fallbackSeconds > 0
    ? Math.round(fallbackSeconds)
    : DEFAULT_POLLING_INTERVAL_SECONDS;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return normalizedFallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(value));
}

/**
 * Returns effective quota values, applying the custom AI credit limit if configured.
 * When a custom limit is set above the plan entitlement, `remaining` and `quota_remaining`
 * are both set to the same effective value (custom limit - used). In the raw API,
 * `remaining` can go negative (for overage tracking) while `quota_remaining` stays at 0,
 * but under a custom limit both represent distance from the custom cap.
 */
export function getEffectiveQuota(quota: QuotaSnapshot, customLimit: number): QuotaSnapshot {
  const planEntitlement = quota.entitlement;
  const used = Math.max(0, planEntitlement - quota.quota_remaining);

  if (customLimit > planEntitlement) {
    const effectiveRemaining = customLimit - used;
    return {
      ...quota,
      entitlement: customLimit,
      remaining: effectiveRemaining,
      quota_remaining: effectiveRemaining,
    };
  }

  return quota;
}

/** Computes display stats from an effective quota snapshot. */
export function computeQuotaStats(eq: QuotaSnapshot): QuotaStats {
  const used = eq.entitlement - eq.quota_remaining;
  const isOverQuota = eq.remaining < 0;
  const percentRemaining = parseFloat(((eq.quota_remaining / eq.entitlement) * 100).toFixed(1));
  const percentUsed = parseFloat(((used / eq.entitlement) * 100).toFixed(1));
  const overageAmount = isOverQuota ? parseFloat(Math.abs(eq.remaining).toFixed(1)) : 0;
  return { used, isOverQuota, percentRemaining, percentUsed, overageAmount };
}

export function calculateDaysUntilReset(
  resetDate: string,
  asOfTime: string
): TimeUntilReset {
  const reset = new Date(resetDate).getTime();
  const asOf = new Date(asOfTime).getTime();
  const diffMs = reset - asOf;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const days = Math.floor(diffDays);
  const hours = Math.floor((diffDays - days) * 24);
  return { days, hours, totalDays: diffDays };
}

export function getMood(percentRemaining: number): { emoji: string; text: string } {
  if (percentRemaining <= 0) {
    return { emoji: "💀", text: "Over quota" };
  } else if (percentRemaining > 75) {
    return { emoji: "😌", text: "Plenty of quota left" };
  } else if (percentRemaining > 40) {
    return { emoji: "🙂", text: "You’re fine" };
  } else if (percentRemaining > 15) {
    return { emoji: "😬", text: "Getting tight" };
  } else {
    return { emoji: "😱", text: "Danger zone" };
  }
}

/**
 * Returns a health badge for the given remaining percentage.
 * `enableColoring` controls whether attention-grabbing icons are used for
 * low-quota states (mirrors the `statusBar.enableColoredBackground` setting).
 */
export function getStatusBadge(
  percentRemaining: number,
  enableColoring: boolean
): StatusBadge {
  if (percentRemaining <= 0) {
    return {
      emoji: "🚫",
      icon: enableColoring ? "$(error)" : "$(circle-slash)",
      label: "Over Quota",
      color: "var(--vscode-charts-red)",
    };
  } else if (percentRemaining > 50) {
    return {
      emoji: "🟢",
      icon: "$(pass)",
      label: "Healthy",
      color: "var(--vscode-charts-green)",
    };
  } else if (percentRemaining >= 20) {
    return {
      emoji: "🟡",
      icon: enableColoring ? "$(warning)" : "$(info)",
      label: "Watch",
      color: "var(--vscode-charts-yellow)",
    };
  } else {
    return {
      emoji: "🔴",
      icon: enableColoring ? "$(error)" : "$(alert)",
      label: "Risk",
      color: "var(--vscode-charts-red)",
    };
  }
}

/** Finds the premium interactions (AI Credits) quota in the user data snapshot map. */
export function findPremiumQuota(
  quotaSnapshots: { [key: string]: QuotaSnapshot } | undefined
): QuotaSnapshot | undefined {
  const arr = quotaSnapshots ? Object.values(quotaSnapshots) : [];
  return arr.find((q) => q.quota_id === "premium_interactions");
}
