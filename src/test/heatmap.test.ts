import * as assert from "assert";
import {
  computeUsageHeatmap,
  computeUsageHeatmapFromRollups,
  HEATMAP_HOUR_BLOCKS,
} from "../core/heatmap";
import { DailyRollup, LocalSnapshot } from "../types";

/** Builds a newest-first snapshot at the given local time. */
function makeSnapshot(localTime: string, remaining: number, entitlement = 300): LocalSnapshot {
  return {
    timestamp: new Date(localTime).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: entitlement,
  };
}

suite("computeUsageHeatmap", () => {
  test("returns null with too few data points", () => {
    assert.strictEqual(computeUsageHeatmap([]), null);
    assert.strictEqual(computeUsageHeatmap([makeSnapshot("2026-07-01T10:00:00", 100)]), null);
    // Only two intervals -> below the default minimum of 3
    const history = [
      makeSnapshot("2026-07-01T12:00:00", 80),
      makeSnapshot("2026-07-01T11:00:00", 90),
      makeSnapshot("2026-07-01T10:00:00", 100),
    ];
    assert.strictEqual(computeUsageHeatmap(history), null);
  });

  test("buckets positive decreases into the newer snapshot's local slot", () => {
    // 2026-07-01 is a Wednesday (getDay() === 3). Newest first.
    const history = [
      makeSnapshot("2026-07-01T22:30:00", 55), // block 5 (20-24), usage 5
      makeSnapshot("2026-07-01T13:00:00", 60), // block 3 (12-16), usage 20
      makeSnapshot("2026-07-01T09:00:00", 80), // block 2 (8-12), usage 20
      makeSnapshot("2026-07-01T01:00:00", 100), // oldest, no interval before it
    ];
    const heatmap = computeUsageHeatmap(history);
    assert.ok(heatmap);
    assert.strictEqual(heatmap.sampleCount, 3);
    assert.strictEqual(heatmap.cells.length, 7);
    assert.strictEqual(heatmap.cells[0].length, HEATMAP_HOUR_BLOCKS);
    assert.strictEqual(heatmap.cells[3][5], 5);
    assert.strictEqual(heatmap.cells[3][3], 20);
    assert.strictEqual(heatmap.cells[3][2], 20);
    assert.strictEqual(heatmap.maxValue, 20);
  });

  test("skips increases (quota resets)", () => {
    const history = [
      makeSnapshot("2026-07-02T10:00:00", 290), // usage 5
      makeSnapshot("2026-07-02T08:00:00", 295), // usage 5
      makeSnapshot("2026-07-02T06:00:00", 300), // increase (reset) -> skipped
      makeSnapshot("2026-07-01T20:00:00", 10), // usage 5
      makeSnapshot("2026-07-01T18:00:00", 15),
    ];
    const heatmap = computeUsageHeatmap(history);
    assert.ok(heatmap);
    assert.strictEqual(heatmap.sampleCount, 3);
    const total = heatmap.cells.flat().reduce((sum, v) => sum + v, 0);
    assert.strictEqual(total, 15);
  });

  test("accumulates multiple intervals into the same bucket", () => {
    // All within Wednesday 08-12 local time.
    const history = [
      makeSnapshot("2026-07-01T11:00:00", 70), // usage 10
      makeSnapshot("2026-07-01T10:00:00", 80), // usage 10
      makeSnapshot("2026-07-01T09:00:00", 90), // usage 10
      makeSnapshot("2026-07-01T08:00:00", 100),
    ];
    const heatmap = computeUsageHeatmap(history);
    assert.ok(heatmap);
    assert.strictEqual(heatmap.cells[3][2], 30);
    assert.strictEqual(heatmap.maxValue, 30);
  });

  test("respects a custom minimum sample count", () => {
    const history = [
      makeSnapshot("2026-07-01T11:00:00", 90),
      makeSnapshot("2026-07-01T10:00:00", 100),
    ];
    const heatmap = computeUsageHeatmap(history, 1);
    assert.ok(heatmap);
    assert.strictEqual(heatmap.sampleCount, 1);
  });
});

suite("computeUsageHeatmapFromRollups", () => {
  /** A rollup with usage placed in specific hour blocks. */
  function rollup(date: string, blocks: Partial<Record<number, number>>): DailyRollup {
    const cells = new Array<number>(HEATMAP_HOUR_BLOCKS).fill(0);
    let used = 0;
    for (const [index, value] of Object.entries(blocks)) {
      cells[Number(index)] = value ?? 0;
      used += value ?? 0;
    }
    return {
      date,
      used,
      endRemaining: 100,
      entitlement: 300,
      samples: 2,
      blocks: cells,
    };
  }

  test("returns null below the minimum sample count", () => {
    // 2026-09-07 is a Monday.
    assert.strictEqual(computeUsageHeatmapFromRollups([rollup("2026-09-07", { 2: 5 })]), null);
  });

  test("maps each rollup onto its weekday row", () => {
    const heatmap = computeUsageHeatmapFromRollups([
      // 2026-09-06 is a Sunday, 2026-09-07 a Monday.
      rollup("2026-09-06", { 1: 4, 3: 6 }),
      rollup("2026-09-07", { 2: 10 }),
    ]);

    assert.ok(heatmap);
    assert.strictEqual(heatmap.cells[0][1], 4);
    assert.strictEqual(heatmap.cells[0][3], 6);
    assert.strictEqual(heatmap.cells[1][2], 10);
    assert.strictEqual(heatmap.maxValue, 10);
    assert.strictEqual(heatmap.sampleCount, 3);
  });

  test("accumulates the same weekday across weeks", () => {
    const heatmap = computeUsageHeatmapFromRollups([
      rollup("2026-09-07", { 2: 10 }),
      rollup("2026-09-14", { 2: 15 }),
      rollup("2026-09-21", { 2: 5 }),
    ]);

    assert.strictEqual(heatmap?.cells[1][2], 30);
  });

  test("ignores an unparseable date", () => {
    const heatmap = computeUsageHeatmapFromRollups([
      rollup("not-a-date", { 1: 50 }),
      rollup("2026-09-07", { 2: 10 }),
      rollup("2026-09-08", { 2: 10 }),
      rollup("2026-09-09", { 2: 10 }),
    ]);

    assert.strictEqual(heatmap?.maxValue, 10);
    assert.strictEqual(heatmap?.sampleCount, 3);
  });
});
