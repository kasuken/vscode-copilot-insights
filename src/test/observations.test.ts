import * as assert from "assert";
import type { Memento } from "vscode";
import { ObservationStore, spikeWindow, UsageInterval } from "../core/observations";

class Memory implements Memento {
  private values = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.values.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) ?? fallback) as T | undefined; }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) { this.values.delete(key); }
    else { this.values.set(key, JSON.parse(JSON.stringify(value))); }
    return Promise.resolve();
  }
}

const period = "2026-11-01T00:00:00Z";
const context = { project: "workspace", branch: "feature", attributable: true };
const options = { enabled: true, credits: 30, windowMinutes: 5, cooldownMinutes: 30 };
const historyPrefix = "copilotInsights.observations.v1.";
const aliceKey = historyPrefix + "host:alice";

suite("Observation timeline and spikes", () => {
  let memory: Memory;
  let store: ObservationStore;
  let start: number;
  setup(() => {
    memory = new Memory();
    store = new ObservationStore(memory);
    store.setAccount("host:alice");
    start = Date.now();
  });
  const intervals = (credits: number[]): UsageInterval[] => credits.map((value, i) => ({
    start: i * 60_000, end: (i + 1) * 60_000, credits: value, gap: false,
  }));

  test("first observation is only a baseline; idle polls advance the interval anchor", () => {
    assert.strictEqual(store.observe(100, 300, period, start, context), undefined);
    store.observe(100, 300, period, start + 60_000, context);
    const drop = store.observe(90, 300, period, start + 120_000, context)!;
    assert.strictEqual(drop.start, start + 60_000);
    assert.strictEqual(drop.credits, 10);
    assert.strictEqual(drop.project, "workspace");
    assert.strictEqual(drop.branch, "feature");
    assert.strictEqual(store.data.lastChange, start + 120_000);
    store.observe(90, 300, period, start + 180_000, context);
    assert.strictEqual(store.data.lastChange, start + 120_000);
    assert.strictEqual(store.data.anchor?.time, start + 180_000);
  });

  test("unfocused or unstable contexts and gaps remain unattributed", () => {
    store.observe(100, 300, period, start, context);
    assert.strictEqual(store.observe(90, 300, period, start + 60_000, { ...context, attributable: false })?.project, undefined);
    const gap = store.observe(50, 300, period, start + 30 * 60_000, context)!;
    assert.strictEqual(gap.gap, true);
    assert.strictEqual(gap.project, undefined);
    assert.strictEqual(store.data.gaps, 1);
    assert.strictEqual(store.takeSpike(options), undefined);
  });

  test("invalid data and failed refreshes interrupt continuity without replacing the anchor", () => {
    store.observe(100, 300, period, start);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      assert.strictEqual(store.observe(invalid, 300, period, start + 60_000), undefined);
    }
    assert.strictEqual(store.observe(90, 0, period, start + 60_000), undefined);
    assert.strictEqual(store.observe(90, 300, "invalid", start + 60_000), undefined);
    assert.strictEqual(store.observe(-Number.MAX_VALUE, 300, period, start + 60_000), undefined);
    assert.strictEqual(store.observe(90, 300, period, Number.MAX_VALUE), undefined);
    assert.strictEqual(store.data.anchor?.time, start);
    assert.strictEqual(store.observe(90, 300, period, start + 60_000, context)?.gap, true);
    store.interrupt();
    assert.strictEqual(store.trackingInterrupted, true);
    assert.strictEqual(store.observe(80, 300, period, start + 120_000, context)?.gap, true);
    assert.strictEqual(store.trackingInterrupted, false);
  });

  test("duplicate timestamps do not double count", () => {
    store.observe(100, 300, period, start);
    store.observe(90, 300, period, start + 60_000);
    assert.strictEqual(store.observe(80, 300, period, start + 60_000), undefined);
    assert.strictEqual(store.observe(80, 300, period, start - 1), undefined);
    assert.strictEqual(store.data.intervals.length, 1);
    assert.strictEqual(store.data.intervals[0].credits, 10);
  });

  test("resets, replenishments and entitlement changes establish baselines without losing recent drops", () => {
    store.observe(100, 300, period, start);
    store.observe(90, 300, period, start + 60_000);
    assert.strictEqual(store.observe(50, 300, "2026-12-01", start + 120_000), undefined);
    assert.strictEqual(store.observe(20, 200, "2026-12-01", start + 180_000), undefined);
    assert.strictEqual(store.observe(200, 200, "2026-12-01", start + 240_000), undefined);
    store.observe(150, 200, "2026-12-01", start + 300_000);
    assert.strictEqual(store.data.intervals.length, 2);
    assert.strictEqual(store.takeSpike(options), undefined);
  });

  test("complete windows include idle intervals, reject partial and discontinuous windows", () => {
    assert.strictEqual(spikeWindow(intervals([10, 10]), 5), undefined);
    assert.strictEqual(spikeWindow(intervals([0, 0, 0, 0, 50]), 5)?.credits, 50);
    assert.strictEqual(spikeWindow(intervals([50, 0, 0, 0, 0]), 5), undefined);
    const broken = intervals([0, 0, 0, 0, 50]);
    broken[2].gap = true;
    assert.strictEqual(spikeWindow(broken, 5), undefined);
    broken[2].gap = false;
    broken[2].end -= 1;
    assert.strictEqual(spikeWindow(broken, 5), undefined);
    assert.strictEqual(spikeWindow([{ start: 0, end: 600_000, credits: 100, gap: false }], 5), undefined);
    assert.strictEqual(spikeWindow([{ start: 0, end: 60_000, credits: NaN, gap: false }], 1), undefined);
  });

  test("cooldown survives restart, reset and account switching; idle polls never notify", () => {
    store.observe(200, 300, period, start);
    for (let i = 1; i <= 5; i++) {
      store.observe(200 - i * 10, 300, period, start + i * 60_000);
    }
    assert.strictEqual(store.takeSpike({ ...options, enabled: false }), undefined);
    assert.strictEqual(store.takeSpike(options)?.credits, 50);
    assert.strictEqual(store.takeSpike(options), undefined);
    store.observe(150, 300, period, start + 6 * 60_000);
    assert.strictEqual(store.takeSpike(options), undefined);
    store.setAccount("host:bob");
    assert.strictEqual(store.data.anchor, undefined);
    store.observe(250, 300, period, start + 6 * 60_000);
    store = new ObservationStore(memory);
    store.setAccount("host:alice");
    assert.strictEqual(store.data.cooldownUntil, start + 35 * 60_000);
    assert.strictEqual(store.observe(140, 300, period, start + 7 * 60_000, context)?.project, undefined);
    store.observe(300, 300, "2026-12-01", start + 8 * 60_000);
    for (let i = 9; i <= 14; i++) { store.observe(300 - (i - 8) * 10, 300, "2026-12-01", start + i * 60_000); }
    assert.strictEqual(store.takeSpike(options), undefined);
    assert.strictEqual(store.data.cooldownUntil, start + 35 * 60_000);
  });

  test("project-only and off remove stored metadata across accounts, including after reload", () => {
    for (const account of ["host:alice", "host:bob"]) {
      store.setAccount(account);
      store.observe(100, 300, period, start, context);
      store.observe(90, 300, period, start + 60_000, context);
    }
    store.configure(7, "project", start + 60_000);
    assert.strictEqual(store.data.intervals[0].branch, undefined);
    store.setAccount("host:alice");
    assert.strictEqual(store.data.intervals[0].project, "workspace");
    assert.strictEqual(store.data.intervals[0].branch, undefined);
    store.configure(7, "off", start + 60_000);
    store = new ObservationStore(memory);
    store.setAccount("host:bob");
    assert.strictEqual(store.data.intervals[0].project, undefined);
    assert.strictEqual(store.data.intervals[0].credits, 10);
  });

  test("retention prunes intervals; disabling deletes all accounts and clear deletes active state", () => {
    store.observe(100, 300, period, start);
    store.observe(90, 300, period, start + 60_000, context);
    store.configure(1, "project", start + 2 * 86400_000);
    assert.strictEqual(store.data.intervals.length, 0);
    store.setAccount("host:bob");
    store.observe(100, 300, period, start);
    store.configure(0, "off", start);
    assert.strictEqual(memory.keys().filter(key => key.startsWith(historyPrefix)).length, 0);
    assert.strictEqual(store.observe(90, 300, period, start + 60_000), undefined);
    store.configure(7, "project", start);
    assert.strictEqual(store.observe(80, 300, period, start + 120_000), undefined);
    store.clear();
    assert.strictEqual(store.data.anchor, undefined);
    assert.strictEqual(store.data.cooldownUntil, undefined);
    assert.strictEqual(memory.keys().filter(key => key.startsWith(historyPrefix)).length, 0);
  });

  function seedSpike(target: ObservationStore): void {
    target.observe(200, 300, period, start, context);
    for (let i = 1; i <= 5; i++) {
      target.observe(200 - i * 10, 300, period, start + i * 60_000, context);
    }
  }

  for (const path of ["poll", "same account", "spike", "configure", "read"] as const) {
    test(`clear invalidates a second cached store before ${path}`, () => {
      seedSpike(store);
      const stale = new ObservationStore(memory);
      stale.setAccount("host:alice");
      store.clear();
      switch (path) {
        case "poll":
          assert.strictEqual(stale.observe(100, 300, period, start + 6 * 60_000, context), undefined);
          break;
        case "same account": stale.setAccount("host:alice"); break;
        case "spike": assert.strictEqual(stale.takeSpike(options), undefined); break;
        case "configure": stale.configure(7, "project-and-branch", start); break;
        case "read": assert.strictEqual(stale.trackingInterrupted, false); break;
      }
      assert.deepStrictEqual(stale.data.intervals, []);
      assert.strictEqual(stale.data.cooldownUntil, undefined);
      assert.strictEqual(stale.data.lastChange, undefined);
      assert.strictEqual(stale.data.gaps, 0);
      assert.strictEqual(stale.data.firstObserved, path === "poll" ? start + 6 * 60_000 : undefined);
      const restored = new ObservationStore(memory);
      restored.setAccount("host:alice");
      assert.deepStrictEqual(restored.data.intervals, []);
      assert.strictEqual(restored.data.cooldownUntil, undefined);
    });
  }

  test("clear discards cached cooldown and permits a wholly new spike window", () => {
    seedSpike(store);
    assert.ok(store.takeSpike(options));
    const stale = new ObservationStore(memory);
    stale.setAccount("host:alice");
    store.clear();
    assert.strictEqual(stale.observe(140, 300, period, start + 6 * 60_000, context), undefined);
    for (let i = 7; i <= 11; i++) {
      stale.observe(140 - (i - 6) * 10, 300, period, start + i * 60_000, context);
    }
    assert.strictEqual(stale.data.intervals.length, 5);
    assert.strictEqual(stale.data.gaps, 0);
    assert.strictEqual(stale.takeSpike(options)?.credits, 50);
  });

  test("clear markers reject delayed obsolete records, including on reload and configure", () => {
    seedSpike(store);
    store.takeSpike(options);
    const obsolete = memory.get(aliceKey);
    store.clear();
    // Simulate an old window's write arriving after the delete.
    void memory.update(aliceKey, obsolete);
    const restored = new ObservationStore(memory);
    restored.configure(7, "project-and-branch", start);
    restored.setAccount("host:alice");
    assert.deepStrictEqual(restored.data, { intervals: [], gaps: 0 });
    assert.strictEqual(restored.takeSpike(options), undefined);
  });

  test("clear is scoped to the exact account and survives switching away and back", () => {
    seedSpike(store);
    store.takeSpike(options);
    const other = new ObservationStore(memory);
    other.setAccount("other-host:alice");
    seedSpike(other);
    const staleAlice = new ObservationStore(memory);
    staleAlice.setAccount("host:alice");
    store.clear();
    assert.strictEqual(other.data.intervals.length, 5);
    assert.strictEqual(other.takeSpike(options)?.credits, 50);
    staleAlice.setAccount("other-host:alice");
    assert.strictEqual(staleAlice.data.cooldownUntil, start + 35 * 60_000);
    staleAlice.setAccount("host:alice");
    assert.deepStrictEqual(staleAlice.data.intervals, []);
    assert.strictEqual(staleAlice.data.anchor, undefined);
    assert.strictEqual(staleAlice.data.cooldownUntil, undefined);
  });

  test("retention zero invalidates all cached accounts even after re-enabling", () => {
    seedSpike(store);
    store.takeSpike(options);
    const stale = new ObservationStore(memory);
    stale.setAccount("host:bob");
    seedSpike(stale);
    stale.takeSpike(options);
    store.configure(0, "off", start);
    assert.strictEqual(stale.enabled, false);
    assert.strictEqual(stale.takeSpike(options), undefined);
    assert.strictEqual(stale.observe(100, 300, period, start + 6 * 60_000, context), undefined);
    assert.deepStrictEqual({ ...stale.data }, { intervals: [], gaps: 0 });
    store.configure(7, "project-and-branch", start);
    stale.configure(7, "project-and-branch", start);
    assert.strictEqual(stale.observe(90, 300, period, start + 7 * 60_000, context), undefined);
    assert.strictEqual(stale.data.cooldownUntil, undefined);
    stale.setAccount("host:alice");
    assert.strictEqual(stale.data.firstObserved, undefined);
    assert.deepStrictEqual(stale.data.intervals, []);
  });

  for (const mode of ["project", "off"] as const) {
    test(`${mode} privacy strips metadata in stale accounts before spike, poll and config writes`, () => {
      store.setAccount("host:bob");
      seedSpike(store);
      const stale = new ObservationStore(memory);
      stale.setAccount("host:bob");
      store.setAccount("host:alice");
      store.configure(7, mode, start);
      assert.strictEqual(stale.takeSpike(options)?.credits, 50);
      stale.observe(140, 300, period, start + 6 * 60_000, context);
      stale.observe(130, 300, period, start + 7 * 60_000, context);
      // Explicitly relaxing the setting must not restore previously stripped data.
      stale.configure(7, "project-and-branch", start);
      const restored = new ObservationStore(memory);
      restored.setAccount("host:bob");
      assert.strictEqual(restored.data.intervals.length, 7);
      for (const interval of restored.data.intervals) {
        assert.strictEqual(interval.branch, undefined);
        if (mode === "off") { assert.strictEqual(interval.project, undefined); }
      }
      if (mode === "project") { assert.strictEqual(restored.data.intervals[0].project, "workspace"); }
    });
  }

  test("privacy generations reject delayed records after settings are relaxed again", () => {
    seedSpike(store);
    store.takeSpike(options);
    const obsolete = memory.get(aliceKey);
    store.configure(0, "off", start);
    store.configure(7, "project-and-branch", start);
    void memory.update(aliceKey, obsolete);
    const restored = new ObservationStore(memory);
    restored.setAccount("host:alice");
    assert.deepStrictEqual(restored.data, { intervals: [], gaps: 0 });
    assert.strictEqual(restored.takeSpike(options), undefined);
  });

  test("a dormant store cannot restore history after missing a disable/re-enable cycle", () => {
    seedSpike(store);
    store.takeSpike(options);
    const stale = new ObservationStore(memory);
    stale.setAccount("host:alice");
    store.configure(0, "off", start);
    store.configure(7, "project-and-branch", start);
    stale.configure(7, "project-and-branch", start);
    assert.strictEqual(stale.takeSpike(options), undefined);
    assert.strictEqual(stale.observe(100, 300, period, start + 6 * 60_000, context), undefined);
    assert.strictEqual(stale.data.cooldownUntil, undefined);
    assert.deepStrictEqual(stale.data.intervals, []);
    assert.strictEqual(stale.data.firstObserved, start + 6 * 60_000);
  });

  test("storage is count bounded even at high polling rates", () => {
    store.observe(100, 300, period, start);
    // Seed a large persisted buffer to test the same pruning path without quadratic writes.
    const key = memory.keys()[0];
    void memory.update(key, {
      ...store.data, intervals: Array.from({ length: 5100 }, (_, index) => ({
        start: start + index, end: start + index + 1, credits: 0, gap: false,
      })),
    });
    store = new ObservationStore(memory);
    store.setAccount("host:alice");
    assert.strictEqual(store.data.intervals.length, 5000);
  });

  test("a gap spanning a billing reset is disclosed without inventing consumption", () => {
    store.observe(100, 300, period, start);
    assert.strictEqual(store.observe(300, 300, "2026-12-01", start + 86400_000), undefined);
    assert.strictEqual(store.data.gaps, 1);
    assert.strictEqual(store.data.intervals.length, 0);
    assert.strictEqual(store.data.lastChange, start + 86400_000);
  });
});
