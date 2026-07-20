import { LocalSnapshot } from "../types";

/** Block characters used to render usage levels, lowest to highest. */
const SPARKLINE_LEVELS = " ▁▂▃▄▅▆█";

/** Returns the local start-of-day key (ms since epoch) for a date. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Builds a Unicode sparkline of daily AI credit usage for the last `days`
 * local days (oldest to newest, ending today). Usage per day is the sum of
 * positive remaining-decreases between consecutive snapshots, attributed to
 * the local day of the newer snapshot. Days without usage render as "▁".
 * Returns null when there is no measurable usage in the window.
 */
export function buildDailyUsageSparkline(
  snapshots: readonly LocalSnapshot[],
  days = 7,
  now = new Date()
): string | null {
  if (snapshots.length < 2 || days <= 0) {
    return null;
  }

  // Local start-of-day keys for the window, oldest to newest (DST-safe).
  const dayKeys: number[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    dayKeys.push(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime()
    );
  }
  const today = dayKeys[dayKeys.length - 1];
  const oldestDay = dayKeys[0];
  const usageByDay = new Map<number, number>();

  // Snapshots are stored newest-first: [i + 1] is older than [i].
  for (let i = 0; i < snapshots.length - 1; i++) {
    const newer = snapshots[i];
    const older = snapshots[i + 1];
    const delta = older.premium_remaining - newer.premium_remaining;
    if (delta <= 0) {
      // No usage, or the quota reset/increased — skip.
      continue;
    }

    const day = startOfLocalDay(new Date(newer.timestamp));
    if (day < oldestDay || day > today) {
      continue;
    }
    usageByDay.set(day, (usageByDay.get(day) ?? 0) + delta);
  }

  const values = dayKeys.map((day) => usageByDay.get(day) ?? 0);

  const max = Math.max(...values);
  if (max <= 0) {
    return null;
  }

  const maxLevel = SPARKLINE_LEVELS.length - 1;
  return values
    .map((value) => {
      if (value <= 0) {
        return SPARKLINE_LEVELS[1]; // "▁" baseline for empty days
      }
      const level = Math.max(1, Math.min(maxLevel, Math.round((value / max) * maxLevel)));
      return SPARKLINE_LEVELS[level];
    })
    .join("");
}
