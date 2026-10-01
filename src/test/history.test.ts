import * as assert from "assert";
import * as vscode from "vscode";
import { getSnapshotComparisons, getUsedToday, SnapshotStore } from "../core/history";
import { AttributionContext } from "../core/attribution";
import {
  ATTRIBUTION_KEY,
  AttributionState,
  CURRENT_PERIOD_KEY,
  DAILY_ROLLUP_KEY,
  DailyRollup,
  LocalSnapshot,
  MAX_RAW_SNAPSHOTS,
  MIN_RAW_SNAPSHOTS,
  PERIOD_SUMMARY_KEY,
  PeriodSummary,
  RAW_RETENTION_HOURS,
  SNAPSHOT_HISTORY_KEY,
} from "../types";

class FakeMemento implements vscode.Memento {
  private readonly _store = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this._store.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this._store.has(key) ? this._store.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this._store.delete(key);
    } else {
      this._store.set(key, value);
    }
    return Promise.resolve();
  }
}

function snapshotAt(hoursAgo: number, remaining: number): LocalSnapshot {
  return {
    timestamp: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: 300,
  };
}

suite("getSnapshotComparisons", () => {
  test("returns nulls with fewer than 2 snapshots", () => {
    assert.deepStrictEqual(getSnapshotComparisons([snapshotAt(0, 100)]), {
      sinceLastRefresh: null,
      sinceYesterday: null,
    });
  });

  test("computes delta since last refresh", () => {
    const comparisons = getSnapshotComparisons([snapshotAt(0, 100), snapshotAt(1, 130)]);
    assert.strictEqual(comparisons.sinceLastRefresh, -30);
    // No snapshot at least 12h old -> no yesterday comparison
    assert.strictEqual(comparisons.sinceYesterday, null);
  });

  test("computes delta since yesterday using closest snapshot", () => {
    const comparisons = getSnapshotComparisons([
      snapshotAt(0, 100),
      snapshotAt(1, 110),
      snapshotAt(23, 150),
      snapshotAt(30, 170),
    ]);
    assert.strictEqual(comparisons.sinceLastRefresh, -10);
    // Closest to 24h ago is the 23h-old snapshot
    assert.strictEqual(comparisons.sinceYesterday, -50);
  });
});

suite("getUsedToday", () => {
  // Fixed local reference time: 15:00 today
  const now = new Date(2026, 6, 5, 15, 0, 0);
  const at = (daysOffset: number, hour: number, remaining: number): LocalSnapshot => ({
    timestamp: new Date(2026, 6, 5 + daysOffset, hour, 0, 0).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: 300,
  });

  test("returns null with fewer than 2 snapshots", () => {
    assert.strictEqual(getUsedToday([at(0, 14, 80)], now), null);
  });

  test("uses the last snapshot before midnight as baseline", () => {
    // 100 remaining at 23:00 yesterday, 80 now -> 20 used today
    const history = [at(0, 14, 80), at(-1, 23, 100), at(-1, 10, 120)];
    assert.strictEqual(getUsedToday(history, now), 20);
  });

  test("falls back to the oldest snapshot from today", () => {
    // No snapshot before midnight; oldest today (09:00, 95) is the baseline
    const history = [at(0, 14, 80), at(0, 9, 95)];
    assert.strictEqual(getUsedToday(history, now), 15);
  });

  test("clamps to zero when quota reset today", () => {
    const history = [at(0, 14, 290), at(-1, 23, 10)];
    assert.strictEqual(getUsedToday(history, now), 0);
  });
});

suite("SnapshotStore", () => {
  test("adds snapshots newest-first and persists", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    store.add(200, 300);
    store.add(180, 300);

    assert.strictEqual(store.snapshots.length, 2);
    assert.strictEqual(store.snapshots[0].premium_remaining, 180);

    const persisted = memento.get<LocalSnapshot[]>(`${SNAPSHOT_HISTORY_KEY}.octocat`);
    assert.strictEqual(persisted?.length, 2);
  });

  test("skips duplicates and invalid entitlements", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    store.add(200, 300);
    store.add(200, 300); // duplicate remaining -> skipped
    store.add(150, 0); // invalid entitlement -> skipped

    assert.strictEqual(store.snapshots.length, 1);
  });

  test("trims history to MAX_RAW_SNAPSHOTS", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    for (let i = 0; i <= MAX_RAW_SNAPSHOTS + 5; i++) {
      store.add(1000 - i, 2000);
    }

    assert.strictEqual(store.snapshots.length, MAX_RAW_SNAPSHOTS);
  });

  test("migrates legacy history to the first account", () => {
    const memento = new FakeMemento();
    const legacy = [snapshotAt(1, 250)];
    void memento.update(SNAPSHOT_HISTORY_KEY, legacy);

    const store = new SnapshotStore(memento);
    store.setAccount("alice");

    assert.strictEqual(store.snapshots.length, 1);
    assert.deepStrictEqual(memento.get(`${SNAPSHOT_HISTORY_KEY}.alice`), legacy);
    assert.strictEqual(memento.get(SNAPSHOT_HISTORY_KEY), undefined);
  });

  test("keeps history separate per account", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);

    store.setAccount("alice");
    store.add(200, 300);

    store.setAccount("bob");
    assert.strictEqual(store.snapshots.length, 0);
    store.add(90, 300);
    assert.strictEqual(store.snapshots.length, 1);

    store.setAccount("alice");
    assert.strictEqual(store.snapshots[0].premium_remaining, 200);
  });
});

suite("SnapshotStore retention", () => {
  test("prunes raw snapshots outside the retention window", () => {
    const memento = new FakeMemento();
    // Seed history that spans well beyond the retention window.
    const seeded: LocalSnapshot[] = [];
    for (let i = 0; i < 60; i++) {
      seeded.push(snapshotAt(i * 4, 1000 - i));
    }
    void memento.update(`${SNAPSHOT_HISTORY_KEY}.octocat`, seeded);

    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    const oldest = new Date(
      store.snapshots[store.snapshots.length - 1].timestamp
    ).getTime();
    const windowStart = Date.now() - RAW_RETENTION_HOURS * 60 * 60 * 1000;

    assert.ok(
      store.snapshots.length < seeded.length,
      "expected old snapshots to be pruned"
    );
    // Everything beyond the window is dropped, except the floor that keeps
    // light users with a usable series.
    assert.ok(store.snapshots.length >= MIN_RAW_SNAPSHOTS);
    assert.ok(
      oldest >= windowStart || store.snapshots.length === MIN_RAW_SNAPSHOTS,
      "snapshots outside the window should only survive via the minimum floor"
    );
  });

  test("keeps at least the minimum number of snapshots regardless of age", () => {
    const memento = new FakeMemento();
    const seeded = [snapshotAt(500, 200), snapshotAt(600, 210)];
    void memento.update(`${SNAPSHOT_HISTORY_KEY}.octocat`, seeded);

    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    assert.strictEqual(store.snapshots.length, 2);
  });
});

suite("SnapshotStore rollups", () => {
  test("records a rollup for every observation, including unchanged ones", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    store.add(300, 300);
    store.add(280, 300);
    store.add(280, 300); // unchanged: no new raw snapshot, but the day stands

    assert.strictEqual(store.snapshots.length, 2);
    assert.strictEqual(store.rollups.length, 1);
    assert.strictEqual(store.rollups[0].used, 20);
  });

  test("persists rollups under the account key", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    store.add(300, 300);
    store.add(250, 300);

    const persisted = memento.get<DailyRollup[]>(`${DAILY_ROLLUP_KEY}.octocat`);
    assert.strictEqual(persisted?.length, 1);
    assert.strictEqual(persisted?.[0].used, 50);
  });

  test("seeds rollups from existing raw history on upgrade", () => {
    const memento = new FakeMemento();
    void memento.update(`${SNAPSHOT_HISTORY_KEY}.octocat`, [
      snapshotAt(1, 240),
      snapshotAt(2, 260),
      snapshotAt(3, 300),
    ]);

    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    assert.ok(store.rollups.length >= 1, "expected rollups to be seeded");
    const totalUsed = store.rollups.reduce((sum, r) => sum + r.used, 0);
    assert.strictEqual(totalUsed, 60);
  });

  test("clear() wipes every tier", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);
    store.setAccount("octocat");
    store.setResetDate("2026-10-01T00:00:00Z");
    store.add(300, 300);
    store.add(250, 300);

    store.clear();

    assert.strictEqual(store.snapshots.length, 0);
    assert.strictEqual(store.rollups.length, 0);
    assert.strictEqual(store.periods.length, 0);
    assert.strictEqual(store.currentPeriod, undefined);
    assert.strictEqual(memento.get(`${DAILY_ROLLUP_KEY}.octocat`), undefined);
    assert.strictEqual(memento.get(`${CURRENT_PERIOD_KEY}.octocat`), undefined);
  });
});

suite("SnapshotStore billing periods", () => {
  const firstReset = "2026-09-01T00:00:00Z";
  const secondReset = "2026-10-01T00:00:00Z";

  test("marks the first tracked period as partial", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");
    store.setResetDate(firstReset);

    assert.strictEqual(store.currentPeriod?.resetDate, firstReset);
    assert.strictEqual(store.currentPeriod?.partial, true);
  });

  test("ignores a reset date that has not changed", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");
    store.setResetDate(firstReset);
    store.setResetDate(firstReset);

    assert.strictEqual(store.periods.length, 0);
  });

  test("archives the closed period and starts a fresh one on rollover", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);
    store.setAccount("octocat");

    const day1 = new Date(2026, 7, 30, 10, 0, 0);
    const day2 = new Date(2026, 7, 31, 10, 0, 0);
    const rolloverDay = new Date(2026, 8, 1, 10, 0, 0);

    store.setResetDate(firstReset, day1);
    store.add(300, 300, day1);
    store.add(260, 300, day2);

    // The billing period rolls over: the balance is restored and the API
    // reports a new reset date.
    store.setResetDate(secondReset, rolloverDay);

    assert.strictEqual(store.periods.length, 1);
    const archived = store.periods[0];
    assert.strictEqual(archived.resetDate, firstReset);
    assert.strictEqual(archived.totalUsed, 40);
    assert.strictEqual(archived.endDate, "2026-08-31");
    assert.strictEqual(archived.partial, true);

    // The new period starts on the rollover day and is fully tracked.
    assert.strictEqual(store.currentPeriod?.resetDate, secondReset);
    assert.strictEqual(store.currentPeriod?.startDate, "2026-09-01");
    assert.strictEqual(store.currentPeriod?.partial, false);

    const persisted = memento.get<PeriodSummary[]>(`${PERIOD_SUMMARY_KEY}.octocat`);
    assert.strictEqual(persisted?.length, 1);
  });

  test("summarizes the period in progress", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    const day1 = new Date(2026, 8, 2, 10, 0, 0);
    const day2 = new Date(2026, 8, 3, 10, 0, 0);

    store.setResetDate(secondReset, day1);
    store.add(300, 300, day1);
    store.add(255, 300, day2);

    const summary = store.summarizeCurrentPeriod(300);
    assert.strictEqual(summary?.totalUsed, 45);
    assert.strictEqual(summary?.daysObserved, 2);
  });

  test("returns no summary before a period is known", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    assert.strictEqual(store.summarizeCurrentPeriod(300), null);
  });

  test("keeps periods separate per account", () => {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);

    store.setAccount("alice");
    store.setResetDate(firstReset);

    store.setAccount("bob");
    assert.strictEqual(store.currentPeriod, undefined);
  });
});

suite("SnapshotStore attribution", () => {
  const reset = "2026-10-01T00:00:00Z";
  const nextReset = "2026-11-01T00:00:00Z";

  /** A context that this window can fully account for. */
  const focused = (project: string, branch = "main"): AttributionContext => ({
    project,
    branch,
    attributable: true,
  });

  function storeWithPeriod(now = new Date(2026, 9, 2, 10, 0, 0)) {
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);
    store.setAccount("octocat");
    store.setResetDate(reset, now);
    return { memento, store };
  }

  test("credits a drop to the foreground project", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const { store } = storeWithPeriod(now);

    store.add(300, 300, now, focused("api"));
    store.add(260, 300, now, focused("api"));

    assert.strictEqual(store.attribution?.buckets.length, 1);
    assert.strictEqual(store.attribution?.buckets[0].project, "api");
    assert.strictEqual(store.attribution?.buckets[0].credits, 40);
  });

  test("records nothing when the window could not account for the interval", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const { store } = storeWithPeriod(now);

    store.add(300, 300, now, focused("api"));
    store.add(260, 300, now, { project: "api", branch: "main", attributable: false });

    assert.strictEqual(store.attribution?.buckets.length ?? 0, 0);
    // The usage itself is still recorded — only its attribution is withheld.
    assert.strictEqual(store.currentPeriodUsed, 40);
  });

  test("records nothing without an attribution context", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const { store } = storeWithPeriod(now);

    store.add(300, 300, now);
    store.add(260, 300, now);

    assert.strictEqual(store.attribution, undefined);
    assert.strictEqual(store.currentPeriodUsed, 40);
  });

  test("persists attribution under the account key", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const { memento, store } = storeWithPeriod(now);

    store.add(300, 300, now, focused("api"));
    store.add(250, 300, now, focused("api"));

    const persisted = memento.get<AttributionState>(`${ATTRIBUTION_KEY}.octocat`);
    assert.strictEqual(persisted?.buckets[0].credits, 50);
    assert.strictEqual(persisted?.resetDate, reset);
  });

  test("tracks the period total alongside attribution", () => {
    const day1 = new Date(2026, 9, 2, 10, 0, 0);
    const day2 = new Date(2026, 9, 3, 10, 0, 0);
    const { store } = storeWithPeriod(day1);

    store.add(300, 300, day1, focused("api"));
    store.add(270, 300, day1, focused("api"));
    store.add(250, 300, day2, focused("web"));

    assert.strictEqual(store.currentPeriodUsed, 50);
    assert.strictEqual(store.attribution?.buckets.length, 2);
  });

  test("archives attribution with the closed period and starts fresh", () => {
    const day1 = new Date(2026, 9, 30, 10, 0, 0);
    const day2 = new Date(2026, 9, 31, 10, 0, 0);
    const rollover = new Date(2026, 10, 1, 10, 0, 0);
    const { store } = storeWithPeriod(day1);

    store.add(300, 300, day1, focused("api"));
    store.add(280, 300, day1, focused("api"));
    store.add(250, 300, day2, focused("web", "feature/x"));

    store.setResetDate(nextReset, rollover);

    const archived = store.periods[0];
    assert.ok(archived.attribution, "the closed period should carry its projects");
    assert.deepStrictEqual(
      archived.attribution.map((bucket) => [bucket.project, bucket.credits]),
      [["web", 30], ["api", 20]]
    );
    // Branches are collapsed in the archive.
    assert.ok(archived.attribution.every((bucket) => bucket.branch === ""));

    // The new period starts with a clean slate keyed to the new reset date.
    assert.strictEqual(store.attribution?.resetDate, nextReset);
    assert.strictEqual(store.attribution?.buckets.length, 0);
  });

  test("clearAttribution forgets the recorded projects", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const { memento, store } = storeWithPeriod(now);

    store.add(300, 300, now, focused("api"));
    store.add(250, 300, now, focused("api"));
    store.clearAttribution();

    assert.strictEqual(store.attribution, undefined);
    assert.strictEqual(memento.get(`${ATTRIBUTION_KEY}.octocat`), undefined);
    // Usage history is untouched — only the project labels are forgotten.
    assert.strictEqual(store.currentPeriodUsed, 50);
  });

  test("keeps attribution separate per account", () => {
    const now = new Date(2026, 9, 2, 10, 0, 0);
    const memento = new FakeMemento();
    const store = new SnapshotStore(memento);

    store.setAccount("alice");
    store.setResetDate(reset, now);
    store.add(300, 300, now, focused("api"));
    store.add(250, 300, now, focused("api"));

    store.setAccount("bob");
    assert.strictEqual(store.attribution, undefined);
  });
});
