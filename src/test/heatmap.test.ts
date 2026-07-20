import * as assert from "assert";
import { computeUsageHeatmap, HEATMAP_HOUR_BLOCKS } from "../core/heatmap";
import { LocalSnapshot } from "../types";

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
