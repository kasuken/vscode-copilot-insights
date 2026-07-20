import { LocalSnapshot } from "../types";

/** Number of hour blocks per day in the heatmap (4-hour blocks). */
export const HEATMAP_HOUR_BLOCKS = 6;
/** Hours covered by each heatmap column. */
export const HEATMAP_BLOCK_HOURS = 24 / HEATMAP_HOUR_BLOCKS;
/** Minimum bucketed usage intervals required to render the heatmap. */
export const HEATMAP_MIN_SAMPLES = 3;

export interface UsageHeatmap {
  /**
   * Credits consumed per bucket: `cells[dayOfWeek][hourBlock]` where
   * dayOfWeek follows Date.getDay() (0 = Sunday) and hourBlock is the local
   * 4-hour block index (0 = 00:00-04:00, ..., 5 = 20:00-24:00).
   */
  cells: number[][];
  /** The largest cell value (0 when all cells are empty). */
  maxValue: number;
  /** Number of positive-usage intervals that were bucketed. */
  sampleCount: number;
}

/**
 * Buckets local snapshot history (newest first) into a day-of-week × 4-hour
 * block usage heatmap. Each positive remaining-decrease between consecutive
 * snapshots is attributed to the local-time bucket of the newer snapshot;
 * increases (quota resets) are skipped. Returns null when fewer than
 * `minSamples` intervals were bucketed.
 */
export function computeUsageHeatmap(
  history: readonly LocalSnapshot[],
  minSamples = HEATMAP_MIN_SAMPLES
): UsageHeatmap | null {
  const cells: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(HEATMAP_HOUR_BLOCKS).fill(0)
  );

  let sampleCount = 0;
  for (let i = 0; i < history.length - 1; i++) {
    const current = history[i];
    const previous = history[i + 1];

    const usage = previous.premium_remaining - current.premium_remaining;
    // Skip resets/increases; only positive consumption counts.
    if (usage <= 0) {
      continue;
    }

    const when = new Date(current.timestamp);
    if (isNaN(when.getTime())) {
      continue;
    }

    const day = when.getDay();
    const block = Math.min(
      HEATMAP_HOUR_BLOCKS - 1,
      Math.floor(when.getHours() / HEATMAP_BLOCK_HOURS)
    );
    cells[day][block] += usage;
    sampleCount++;
  }

  if (sampleCount < minSamples) {
    return null;
  }

  const maxValue = Math.max(...cells.map((row) => Math.max(...row)));

  return { cells, maxValue, sampleCount };
}
