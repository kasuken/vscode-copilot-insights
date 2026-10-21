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
    assert.strictEqual(memory.keys().length, 0);
    assert.strictEqual(store.observe(90, 300, period, start + 60_000), undefined);
    store.configure(7, "project", start);
    assert.strictEqual(store.observe(80, 300, period, start + 120_000), undefined);
    store.clear();
    assert.strictEqual(store.data.anchor, undefined);
    assert.strictEqual(store.data.cooldownUntil, undefined);
    assert.strictEqual(memory.keys().length, 0);
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
