import * as assert from "assert";
import * as vscode from "vscode";
import { getSnapshotComparisons, getUsedToday, SnapshotStore } from "../core/history";
import { LocalSnapshot, MAX_SNAPSHOTS, SNAPSHOT_HISTORY_KEY } from "../types";

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

  test("trims history to MAX_SNAPSHOTS", () => {
    const store = new SnapshotStore(new FakeMemento());
    store.setAccount("octocat");

    for (let i = 0; i <= MAX_SNAPSHOTS + 5; i++) {
      store.add(1000 - i, 2000);
    }

    assert.strictEqual(store.snapshots.length, MAX_SNAPSHOTS);
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
