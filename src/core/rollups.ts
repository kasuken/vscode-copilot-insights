import {
  CurrentPeriod,
  DailyRollup,
  LocalSnapshot,
  MAX_DAILY_ROLLUPS,
  PeriodSummary,
} from "../types";
import { HEATMAP_BLOCK_HOURS, HEATMAP_HOUR_BLOCKS } from "./heatmap";

/**
 * Daily rollups are the durable tier of usage history.
 *
 * Raw snapshots are dense (one per polling interval that moved the balance)
 * and therefore short-lived: a heavy Copilot day can produce hundreds. Folding
 * each observation into a per-day bucket keeps the whole billing period — and
 * a year of periods — in bounded storage, so the burn-down, heatmap, and
 * forecasts no longer degrade as usage goes up.
 *
 * Rollup lists are kept **ascending by date** (oldest first), the opposite of
 * the newest-first raw snapshot list.
 */

/** Rounds to two decimals, keeping accumulated floats from drifting. */
function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

/** Formats a date as a local-time `YYYY-MM-DD` key. */
export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Returns the local 4-hour block index (0 = 00:00-04:00) for a date. */
export function hourBlockIndex(value: Date): number {
  return Math.min(
    HEATMAP_HOUR_BLOCKS - 1,
    Math.max(0, Math.floor(value.getHours() / HEATMAP_BLOCK_HOURS))
  );
}

function emptyBlocks(): number[] {
  return new Array<number>(HEATMAP_HOUR_BLOCKS).fill(0);
}

/** A single quota observation to fold into the rollups. */
export interface Observation {
  /** ISO timestamp of the observation. */
  timestamp: string;
  /** Remaining AI credits reported at that moment. */
  remaining: number;
  /** Plan entitlement reported at that moment. */
  entitlement: number;
}

/**
 * Folds one observation into a rollup list, returning a new list.
 *
 * `previousRemaining` is the balance at the previous observation, or null when
 * there is nothing to diff against. A drop counts as usage and is attributed
 * to the local day and hour block of the *new* observation (matching how the
 * heatmap has always bucketed intervals). An increase — a quota reset, or an
 * entitlement change mid-period — updates the balance without counting usage.
 */
export function foldObservation(
  rollups: readonly DailyRollup[],
  observation: Observation,
  previousRemaining: number | null
): DailyRollup[] {
  const when = new Date(observation.timestamp);
  if (isNaN(when.getTime())) {
    return [...rollups];
  }

  const date = localDateKey(when);
  const delta =
    previousRemaining === null ? 0 : Math.max(0, previousRemaining - observation.remaining);

  const next = rollups.map((rollup) => ({ ...rollup, blocks: [...rollup.blocks] }));
  const index = next.findIndex((rollup) => rollup.date === date);

  if (index === -1) {
    const created: DailyRollup = {
      date,
      used: round2(delta),
      endRemaining: observation.remaining,
      entitlement: observation.entitlement,
      samples: 1,
      blocks: emptyBlocks(),
    };
    created.blocks[hourBlockIndex(when)] = round2(delta);

    // Normally this appends; the search covers clock changes and any
    // out-of-order timestamps, keeping the list sorted by date.
    const insertAt = next.findIndex((rollup) => rollup.date > date);
    if (insertAt === -1) {
      next.push(created);
    } else {
      next.splice(insertAt, 0, created);
    }
  } else {
    const rollup = next[index];
    rollup.used = round2(rollup.used + delta);
    const block = hourBlockIndex(when);
    rollup.blocks[block] = round2((rollup.blocks[block] ?? 0) + delta);
    rollup.endRemaining = observation.remaining;
    rollup.entitlement = observation.entitlement;
    rollup.samples += 1;
  }

  return next.length > MAX_DAILY_ROLLUPS
    ? next.slice(next.length - MAX_DAILY_ROLLUPS)
    : next;
}

/**
 * Rebuilds rollups from raw snapshot history (newest first). Used once to seed
 * the durable tier for users upgrading from a raw-snapshot-only version, so
 * existing history isn't thrown away.
 */
export function buildRollupsFromSnapshots(snapshots: readonly LocalSnapshot[]): DailyRollup[] {
  let rollups: DailyRollup[] = [];
  let previousRemaining: number | null = null;

  // Raw history is newest first; fold it oldest to newest.
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snapshot = snapshots[i];
    rollups = foldObservation(
      rollups,
      {
        timestamp: snapshot.timestamp,
        remaining: snapshot.premium_remaining,
        entitlement: snapshot.premium_entitlement,
      },
      previousRemaining
    );
    previousRemaining = snapshot.premium_remaining;
  }

  return rollups;
}

/**
 * Credits consumed today, from the rollup for the current local date.
 * Returns null when today hasn't been observed yet.
 */
export function getUsedTodayFromRollups(
  rollups: readonly DailyRollup[],
  now = new Date()
): number | null {
  const today = localDateKey(now);
  const rollup = rollups.find((entry) => entry.date === today);
  return rollup ? rollup.used : null;
}

/**
 * Rollups belonging to a period: dated on or after its start date, and on or
 * before `endDate` when one is given (used to close a period at a day
 * boundary so archived periods never overlap).
 */
export function rollupsInPeriod(
  rollups: readonly DailyRollup[],
  startDate: string,
  endDate?: string
): DailyRollup[] {
  // `YYYY-MM-DD` keys compare correctly as strings.
  return rollups.filter(
    (rollup) => rollup.date >= startDate && (endDate === undefined || rollup.date <= endDate)
  );
}

/**
 * Summarizes the rollups belonging to a billing period. Returns null when the
 * period has no observed days yet.
 *
 * `fallbackEntitlement` is used when no rollup recorded one (e.g. every
 * observation arrived before the entitlement was known). `endDate` closes the
 * period at a day boundary when archiving.
 */
export function summarizePeriod(
  rollups: readonly DailyRollup[],
  period: CurrentPeriod,
  fallbackEntitlement = 0,
  endDate?: string
): PeriodSummary | null {
  const inPeriod = rollupsInPeriod(rollups, period.startDate, endDate);
  if (inPeriod.length === 0) {
    return null;
  }

  let totalUsed = 0;
  let peakDayUsed = 0;
  let peakDayDate = "";
  let entitlement = 0;

  for (const rollup of inPeriod) {
    totalUsed += rollup.used;
    if (rollup.used > peakDayUsed) {
      peakDayUsed = rollup.used;
      peakDayDate = rollup.date;
    }
    if (rollup.entitlement > entitlement) {
      entitlement = rollup.entitlement;
    }
  }

  const last = inPeriod[inPeriod.length - 1];
  // The API lets `remaining` go negative once overage kicks in, so the closing
  // balance is a more direct overage signal than used-minus-entitlement.
  const overageCredits = last.endRemaining < 0 ? round2(-last.endRemaining) : 0;

  return {
    resetDate: period.resetDate,
    startDate: inPeriod[0].date,
    endDate: last.date,
    entitlement: entitlement || fallbackEntitlement,
    totalUsed: round2(totalUsed),
    peakDayDate,
    peakDayUsed: round2(peakDayUsed),
    daysObserved: inPeriod.length,
    overageCredits,
    partial: period.partial,
  };
}

/** A period measured against the one before it. */
export interface PeriodComparison {
  current: PeriodSummary;
  previous: PeriodSummary | null;
  /** Credits used this period minus last period, or null without a previous. */
  usedDelta: number | null;
  /** That delta as a percentage of last period, or null when not computable. */
  usedDeltaPercent: number | null;
  /** Average credits per observed day this period. */
  avgPerDay: number;
  /** Average credits per observed day last period, or null. */
  previousAvgPerDay: number | null;
  /**
   * True when the comparison spans periods of different observed length, so
   * the totals aren't directly comparable.
   */
  unevenCoverage: boolean;
}

/** Computes averages and deltas between the current and previous period. */
export function comparePeriods(
  current: PeriodSummary,
  previous: PeriodSummary | null
): PeriodComparison {
  const avgPerDay = current.daysObserved > 0 ? round2(current.totalUsed / current.daysObserved) : 0;

  if (!previous) {
    return {
      current,
      previous: null,
      usedDelta: null,
      usedDeltaPercent: null,
      avgPerDay,
      previousAvgPerDay: null,
      unevenCoverage: false,
    };
  }

  const previousAvgPerDay =
    previous.daysObserved > 0 ? round2(previous.totalUsed / previous.daysObserved) : 0;
  const usedDelta = round2(current.totalUsed - previous.totalUsed);
  const usedDeltaPercent =
    previous.totalUsed > 0 ? round2((usedDelta / previous.totalUsed) * 100) : null;

  return {
    current,
    previous,
    usedDelta,
    usedDeltaPercent,
    avgPerDay,
    previousAvgPerDay,
    // The current period is still running, so its day count is expected to be
    // lower; only flag coverage that also differs from the previous period's.
    unevenCoverage:
      previous.partial || current.partial || current.daysObserved !== previous.daysObserved,
  };
}
