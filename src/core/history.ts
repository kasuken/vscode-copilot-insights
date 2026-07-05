import * as vscode from "vscode";
import { LocalSnapshot, MAX_SNAPSHOTS, SNAPSHOT_HISTORY_KEY } from "../types";

export interface SnapshotComparisons {
  sinceLastRefresh: number | null;
  sinceYesterday: number | null;
}

/**
 * Stores a local history of AI credit snapshots in VS Code global state.
 * History is keyed per GitHub account (login) so switching accounts doesn't
 * mix usage data. Legacy single-account history is migrated to the first
 * account that loads data.
 */
export class SnapshotStore {
  private _snapshots: LocalSnapshot[] = [];
  private _login: string | undefined;

  constructor(private readonly _globalState: vscode.Memento) {
    // Until an account is known, expose legacy history (if any) read-only.
    this._snapshots = this._globalState.get<LocalSnapshot[]>(SNAPSHOT_HISTORY_KEY, []);
  }

  get snapshots(): readonly LocalSnapshot[] {
    return this._snapshots;
  }

  private get _storageKey(): string {
    return this._login
      ? `${SNAPSHOT_HISTORY_KEY}.${this._login}`
      : SNAPSHOT_HISTORY_KEY;
  }

  /**
   * Switches the store to the given account, migrating legacy (un-keyed)
   * history to this account on first use.
   */
  setAccount(login: string): void {
    if (!login || this._login === login) {
      return;
    }

    this._login = login;
    const keyed = this._globalState.get<LocalSnapshot[]>(this._storageKey);

    if (keyed) {
      this._snapshots = keyed;
      return;
    }

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

  add(premiumRemaining: number, premiumEntitlement: number): void {
    // Don't add snapshots with invalid entitlement values
    if (premiumEntitlement <= 0) {
      return;
    }

    // Don't add if value is the same as the last snapshot
    if (this._snapshots.length > 0 && this._snapshots[0].premium_remaining === premiumRemaining) {
      return;
    }

    const newSnapshot: LocalSnapshot = {
      timestamp: new Date().toISOString(),
      premium_remaining: premiumRemaining,
      premium_entitlement: premiumEntitlement,
    };

    this._snapshots.unshift(newSnapshot);

    if (this._snapshots.length > MAX_SNAPSHOTS) {
      this._snapshots = this._snapshots.slice(0, MAX_SNAPSHOTS);
    }

    void this._globalState.update(this._storageKey, this._snapshots);
  }

  clear(): void {
    this._snapshots = [];
    void this._globalState.update(this._storageKey, undefined);
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
