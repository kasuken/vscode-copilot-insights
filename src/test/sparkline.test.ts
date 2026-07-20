import * as assert from "assert";
import { buildDailyUsageSparkline } from "../core/sparkline";
import { LocalSnapshot } from "../types";

suite("buildDailyUsageSparkline", () => {
  // Fixed local reference time: 15:00 on 2026-07-05
  const now = new Date(2026, 6, 5, 15, 0, 0);
  const at = (daysOffset: number, hour: number, remaining: number): LocalSnapshot => ({
    timestamp: new Date(2026, 6, 5 + daysOffset, hour, 0, 0).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: 300,
  });

  test("returns null with fewer than 2 snapshots", () => {
    assert.strictEqual(buildDailyUsageSparkline([], 7, now), null);
    assert.strictEqual(buildDailyUsageSparkline([at(0, 14, 80)], 7, now), null);
  });

  test("returns null when there is no usage in the window", () => {
    // Quota only increased (reset) — no positive decreases
    const history = [at(0, 14, 300), at(-1, 10, 20)];
    assert.strictEqual(buildDailyUsageSparkline(history, 7, now), null);
  });

  test("renders a 7-character sparkline with the max day at full height", () => {
    // Newest-first: 70 used today, 10 used 3 days ago
    const history = [
      at(0, 14, 100), // today: 170 -> 100 = 70 used
      at(-1, 23, 170),
      at(-3, 12, 170), // 3 days ago: 180 -> 170 = 10 used
      at(-3, 9, 180),
    ];
    const sparkline = buildDailyUsageSparkline(history, 7, now);
    assert.ok(sparkline);
    assert.strictEqual(sparkline.length, 7);
    // Empty days render as the baseline character
    assert.strictEqual(sparkline, "▁▁▁▁▁▁█");
    assert.strictEqual(sparkline[6], "█"); // today has the max usage
    assert.strictEqual(sparkline[3], "▁"); // 3 days ago: 10/70 -> lowest level
    assert.strictEqual(sparkline[0], "▁"); // no data -> baseline
  });

  test("sums multiple decreases within the same day", () => {
    const history = [
      at(0, 14, 80), // 90 -> 80 = 10
      at(0, 10, 90), // 100 -> 90 = 10
      at(-1, 23, 100), // yesterday baseline: 110 -> 100 = 10 for yesterday
      at(-1, 10, 110),
    ];
    const sparkline = buildDailyUsageSparkline(history, 7, now);
    assert.ok(sparkline);
    // Today: 20 used (max), yesterday: 10 used (half -> mid level)
    assert.strictEqual(sparkline[6], "█");
    assert.strictEqual(sparkline[5], "▄");
  });

  test("ignores usage outside the window and skips reset increases", () => {
    const history = [
      at(0, 14, 80), // today: 100 -> 80 = 20 used
      at(-1, 23, 100), // reset yesterday: 5 -> 100 (skipped)
      at(-10, 12, 5), // outside the 7-day window
      at(-10, 9, 50),
    ];
    const sparkline = buildDailyUsageSparkline(history, 7, now);
    assert.strictEqual(sparkline, "▁▁▁▁▁▁█");
  });

  test("respects a custom day count", () => {
    const history = [at(0, 14, 80), at(0, 9, 100)];
    const sparkline = buildDailyUsageSparkline(history, 3, now);
    assert.strictEqual(sparkline, "▁▁█");
  });
});
