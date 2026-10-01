import * as vscode from "vscode";
import {
  ATTRIBUTION_KEY,
  AttributionState,
  CURRENT_PERIOD_KEY,
  CurrentPeriod,
  DAILY_ROLLUP_KEY,
  DailyRollup,
  LocalSnapshot,
  MAX_PERIOD_SUMMARIES,
  MAX_RAW_SNAPSHOTS,
  MIN_RAW_SNAPSHOTS,
  PERIOD_SUMMARY_KEY,
  PeriodSummary,
  RAW_RETENTION_HOURS,
  SNAPSHOT_HISTORY_KEY,
} from "../types";
import {
  buildRollupsFromSnapshots,
  foldObservation,
  localDateKey,
  rollupsInPeriod,
  summarizePeriod,
} from "./rollups";
import {
  archiveAttribution,
  attributeCredits,
  AttributionContext,
  emptyAttribution,
} from "./attribution";

export interface SnapshotComparisons {
  sinceLastRefresh: number | null;
  sinceYesterday: number | null;
}

/** Local-date key for the day before `date`. */
function previousDateKey(date: Date): string {
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  return localDateKey(yesterday);
}

/**
 * Stores AI credit history in VS Code global state, in two tiers:
 *
 * - **Raw snapshots** — one per observed balance change, kept for ~48 hours.
 *   They power the short-range views (deltas since last refresh, the snapshot
 *   chart) where minute-level detail matters.
 * - **Daily rollups** — one per calendar day, kept for months. They power the
 *   burn-down, heatmap, forecasts, and period comparisons.
 *
 * The split matters because raw snapshots are produced at the polling rate:
 * capping them by count alone meant the heaviest users — who need forecasting
 * most — retained the least history. Rollups keep the full billing period at
 * bounded cost regardless of how hard Copilot is used.
 *
 * Everything is keyed per GitHub account (login) so switching accounts doesn't
 * mix usage data. Legacy single-account history is migrated to the first
 * account that loads data.
 */
export class SnapshotStore {
  private _snapshots: LocalSnapshot[] = [];
  private _rollups: DailyRollup[] = [];
  private _periods: PeriodSummary[] = [];
  private _currentPeriod: CurrentPeriod | undefined;
  private _attribution: AttributionState | undefined;
  private _login: string | undefined;

  constructor(private readonly _globalState: vscode.Memento) {
    // Until an account is known, expose legacy history (if any) read-only.
    this._snapshots = this._globalState.get<LocalSnapshot[]>(SNAPSHOT_HISTORY_KEY, []);
  }

  /** Raw snapshots, newest first. */
  get snapshots(): readonly LocalSnapshot[] {
    return this._snapshots;
  }

  /** Daily rollups, oldest first. */
  get rollups(): readonly DailyRollup[] {
    return this._rollups;
  }

  /** Archived billing periods, oldest first. */
  get periods(): readonly PeriodSummary[] {
    return this._periods;
  }

  /** The billing period currently being tracked, if one is known. */
  get currentPeriod(): CurrentPeriod | undefined {
    return this._currentPeriod;
  }

  /** Credit attribution for the period in progress, if any is recorded. */
  get attribution(): AttributionState | undefined {
    return this._attribution;
  }

  /** Total credits used in the period so far, from the daily rollups. */
  get currentPeriodUsed(): number {
    if (!this._currentPeriod) {
      return 0;
    }
    const inPeriod = rollupsInPeriod(this._rollups, this._currentPeriod.startDate);
    return parseFloat(inPeriod.reduce((sum, rollup) => sum + rollup.used, 0).toFixed(2));
  }

  private _key(prefix: string): string {
    return this._login ? `${prefix}.${this._login}` : prefix;
  }

  private get _storageKey(): string {
    return this._key(SNAPSHOT_HISTORY_KEY);
  }

  /**
   * Switches the store to the given account, migrating legacy (un-keyed)
   * history to this account on first use and seeding the daily rollups from
   * whatever raw history already exists.
   */
  setAccount(login: string): void {
    if (!login || this._login === login) {
      return;
    }

    this._login = login;
    const keyed = this._globalState.get<LocalSnapshot[]>(this._storageKey);

    if (keyed) {
      this._snapshots = keyed;
    } else {
      // Migrate legacy history (if present) to this account.
      const legacy = this._globalState.get<LocalSnapshot[]>(SNAPSHOT_HISTORY_KEY);
      if (legacy && legacy.length > 0) {
        this._snapshots = legacy;
        void this._globalState.update(this._storageKey, legacy);
        void this._globalState.update(SNAPSHOT_HISTORY_KEY, undefined);
      } else {
        this._snapshots = [];
      }
    }

    this._periods = this._globalState.get<PeriodSummary[]>(this._key(PERIOD_SUMMARY_KEY), []);
    this._currentPeriod = this._globalState.get<CurrentPeriod>(this._key(CURRENT_PERIOD_KEY));
    this._attribution = this._globalState.get<AttributionState>(this._key(ATTRIBUTION_KEY));

    const storedRollups = this._globalState.get<DailyRollup[]>(this._key(DAILY_ROLLUP_KEY));
    if (storedRollups) {
      this._rollups = storedRollups;
    } else if (this._snapshots.length > 0) {
      // Upgrading from a raw-snapshot-only version: rebuild the durable tier
      // from what we have rather than starting from nothing.
      this._rollups = buildRollupsFromSnapshots(this._snapshots);
      void this._globalState.update(this._key(DAILY_ROLLUP_KEY), this._rollups);
    } else {
      this._rollups = [];
    }

    // Raw history from older versions can exceed the new time-based window.
    this._pruneSnapshots();
  }

  /**
   * Records the billing period a fetch belongs to. When the reset date rolls
   * over, the period that just ended is summarized and archived, and a new one
   * starts today.
   *
   * Call this *before* {@link add} for the same fetch so usage is attributed
   * to the right period.
   */
  setResetDate(resetDate: string, now = new Date()): void {
    if (!resetDate) {
      return;
    }

    if (!this._currentPeriod) {
      // First run for this account. Tracking almost certainly started after
      // the period began, so the totals are flagged as partial.
      this._setCurrentPeriod({
        resetDate,
        startDate: this._rollups[0]?.date ?? localDateKey(now),
        partial: true,
      });
      return;
    }

    if (this._currentPeriod.resetDate === resetDate) {
      return;
    }

    // The period closes at yesterday and the new one starts today, so archived
    // periods never overlap. Usage recorded earlier today, before the rollover
    // was observed, is counted in the new period — a bounded approximation on
    // one day per period.
    const summary = summarizePeriod(
      this._rollups,
      this._currentPeriod,
      0,
      previousDateKey(now)
    );

    if (summary) {
      // Carry the period's project breakdown into the archive before the
      // buckets are reset for the new period.
      const archived = archiveAttribution(this._attribution);
      if (archived) {
        summary.attribution = archived;
      }
      this._periods = [...this._periods, summary];
      if (this._periods.length > MAX_PERIOD_SUMMARIES) {
        this._periods = this._periods.slice(this._periods.length - MAX_PERIOD_SUMMARIES);
      }
      void this._globalState.update(this._key(PERIOD_SUMMARY_KEY), this._periods);
    }

    this._setCurrentPeriod({
      resetDate,
      startDate: localDateKey(now),
      partial: false,
    });
    this._setAttribution(emptyAttribution(resetDate));
  }

  private _setAttribution(state: AttributionState | undefined): void {
    this._attribution = state;
    void this._globalState.update(this._key(ATTRIBUTION_KEY), state);
  }

  /**
   * Forgets every project and branch recorded for the current period. Called
   * when the user turns attribution off, so switching it off also deletes what
   * it collected.
   */
  clearAttribution(): void {
    this._setAttribution(undefined);
  }

  private _setCurrentPeriod(period: CurrentPeriod): void {
    this._currentPeriod = period;
    void this._globalState.update(this._key(CURRENT_PERIOD_KEY), period);
  }

  /**
   * Summarizes the period in progress from the rollups recorded so far.
   * Returns null before any day of the period has been observed.
   */
  summarizeCurrentPeriod(entitlement = 0): PeriodSummary | null {
    if (!this._currentPeriod) {
      return null;
    }
    return summarizePeriod(this._rollups, this._currentPeriod, entitlement);
  }

  /**
   * Records one quota observation.
   *
   * Every observation is folded into the daily rollups; a raw snapshot is
   * appended only when the balance actually moved, so an idle poll costs
   * nothing but still marks the day as observed.
   */
  add(
    premiumRemaining: number,
    premiumEntitlement: number,
    now = new Date(),
    context?: AttributionContext
  ): void {
    // Don't record observations with invalid entitlement values
    if (premiumEntitlement <= 0) {
      return;
    }

    const previousRemaining =
      this._snapshots.length > 0 ? this._snapshots[0].premium_remaining : null;
    const changed = previousRemaining === null || previousRemaining !== premiumRemaining;
    const timestamp = now.toISOString();
    const today = localDateKey(now);
    const hasToday = this._rollups.some((rollup) => rollup.date === today);

    if (context && previousRemaining !== null) {
      this._recordAttribution(previousRemaining - premiumRemaining, context, today);
    }

    // Fold when there is something to record, or to open today's rollup so a
    // day spent without spending credits still counts as observed.
    if (changed || !hasToday) {
      this._rollups = foldObservation(
        this._rollups,
        { timestamp, remaining: premiumRemaining, entitlement: premiumEntitlement },
        previousRemaining
      );
      void this._globalState.update(this._key(DAILY_ROLLUP_KEY), this._rollups);
    }

    if (!changed) {
      return;
    }

    this._snapshots.unshift({
      timestamp,
      premium_remaining: premiumRemaining,
      premium_entitlement: premiumEntitlement,
    });

    this._pruneSnapshots(now);
    void this._globalState.update(this._storageKey, this._snapshots);
  }

  /**
   * Credits a drop in the balance to the given foreground context. Only
   * attributed credits are stored; what this window cannot account for is
   * simply left out and derived later from the period total.
   */
  private _recordAttribution(
    credits: number,
    context: AttributionContext,
    date: string
  ): void {
    if (!context.attributable || !(credits > 0) || !this._currentPeriod) {
      return;
    }

    const state =
      this._attribution?.resetDate === this._currentPeriod.resetDate
        ? this._attribution
        : emptyAttribution(this._currentPeriod.resetDate);

    this._setAttribution(attributeCredits(state, credits, context, date));
  }

  /**
   * Trims raw snapshots to the retention window. Snapshots inside the window
   * are always kept, plus the newest {@link MIN_RAW_SNAPSHOTS} regardless of
   * age so light users keep a usable series, and never more than
   * {@link MAX_RAW_SNAPSHOTS} in total.
   */
  private _pruneSnapshots(now = new Date()): void {
    const cutoff = now.getTime() - RAW_RETENTION_HOURS * 60 * 60 * 1000;

    let keep = 0;
    for (const snapshot of this._snapshots) {
      const time = new Date(snapshot.timestamp).getTime();
      // Unparseable timestamps are kept rather than silently dropped.
      if (Number.isFinite(time) && time < cutoff) {
        break;
      }
      keep++;
    }

    keep = Math.max(keep, Math.min(MIN_RAW_SNAPSHOTS, this._snapshots.length));
    keep = Math.min(keep, MAX_RAW_SNAPSHOTS);

    if (keep < this._snapshots.length) {
      this._snapshots = this._snapshots.slice(0, keep);
    }
  }

  /** Clears every tier of stored history for the active account. */
  clear(): void {
    this._snapshots = [];
    this._rollups = [];
    this._periods = [];
    this._currentPeriod = undefined;
    this._attribution = undefined;
    void this._globalState.update(this._storageKey, undefined);
    void this._globalState.update(this._key(DAILY_ROLLUP_KEY), undefined);
    void this._globalState.update(this._key(PERIOD_SUMMARY_KEY), undefined);
    void this._globalState.update(this._key(CURRENT_PERIOD_KEY), undefined);
    void this._globalState.update(this._key(ATTRIBUTION_KEY), undefined);
  }

  getComparisons(): SnapshotComparisons {
    return getSnapshotComparisons(this._snapshots);
  }
}

/** Computes deltas vs the previous refresh and vs ~24 hours ago. */
export function getSnapshotComparisons(history: readonly LocalSnapshot[]): SnapshotComparisons {
  const result: SnapshotComparisons = { sinceLastRefresh: null, sinceYesterday: null };

  if (history.length < 2) {
    return result;
  }

  const current = history[0];
  const previousRefresh = history[1];

  result.sinceLastRefresh = current.premium_remaining - previousRefresh.premium_remaining;

  const now = new Date(current.timestamp).getTime();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  let closestYesterdaySnapshot: LocalSnapshot | null = null;
  let closestTimeDiff = Infinity;

  for (const snapshot of history) {
    const snapshotTime = new Date(snapshot.timestamp).getTime();
    const timeDiff = Math.abs(snapshotTime - oneDayAgo);

    if (snapshotTime <= now - 12 * 60 * 60 * 1000 && timeDiff < closestTimeDiff) {
      closestTimeDiff = timeDiff;
      closestYesterdaySnapshot = snapshot;
    }
  }

  if (closestYesterdaySnapshot) {
    result.sinceYesterday = current.premium_remaining - closestYesterdaySnapshot.premium_remaining;
  }

  return result;
}

/**
 * Computes AI credits consumed since local midnight, based on the recorded
 * snapshot history (newest first). Returns null when there is no measurable
 * delta for today (e.g. no snapshot recorded yet today).
 *
 * Prefer the daily rollup for today when one exists — it survives raw snapshot
 * pruning. This remains for the short window before the first rollup exists.
 */
export function getUsedToday(history: readonly LocalSnapshot[], now = new Date()): number | null {
  if (history.length < 2) {
    return null;
  }

  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const current = history[0];

  // Baseline: the most recent snapshot at or before local midnight, or the
  // oldest snapshot from today when nothing older exists.
  let baseline: LocalSnapshot | undefined;
  for (const snapshot of history) {
    baseline = snapshot;
    if (new Date(snapshot.timestamp).getTime() <= midnight) {
      break;
    }
  }

  if (!baseline || baseline === current) {
    return null;
  }

  const used = baseline.premium_remaining - current.premium_remaining;
  // Negative deltas mean the quota reset or increased today — report 0.
  return Math.max(0, parseFloat(used.toFixed(2)));
}
