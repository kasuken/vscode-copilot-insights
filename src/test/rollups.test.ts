import * as assert from "assert";
import {
  buildRollupsFromSnapshots,
  comparePeriods,
  foldObservation,
  getUsedTodayFromRollups,
  hourBlockIndex,
  localDateKey,
  rollupsInPeriod,
  summarizePeriod,
} from "../core/rollups";
import { CurrentPeriod, DailyRollup, LocalSnapshot, MAX_DAILY_ROLLUPS } from "../types";

/** Local timestamp so tests don't depend on the machine's timezone. */
function localIso(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function observe(
  rollups: readonly DailyRollup[],
  timestamp: string,
  remaining: number,
  previousRemaining: number | null,
  entitlement = 300
): DailyRollup[] {
  return foldObservation(rollups, { timestamp, remaining, entitlement }, previousRemaining);
}

suite("localDateKey / hourBlockIndex", () => {
  test("formats a local date as YYYY-MM-DD", () => {
    assert.strictEqual(localDateKey(new Date(2026, 8, 5, 23, 30)), "2026-09-05");
    assert.strictEqual(localDateKey(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
  });

  test("maps local hours onto 4-hour blocks", () => {
    assert.strictEqual(hourBlockIndex(new Date(2026, 8, 5, 0, 0)), 0);
    assert.strictEqual(hourBlockIndex(new Date(2026, 8, 5, 3, 59)), 0);
    assert.strictEqual(hourBlockIndex(new Date(2026, 8, 5, 4, 0)), 1);
    assert.strictEqual(hourBlockIndex(new Date(2026, 8, 5, 23, 59)), 5);
  });
});

suite("foldObservation", () => {
  test("creates a rollup for the first observation without counting usage", () => {
    const rollups = observe([], localIso(2026, 9, 5, 10), 280, null);

    assert.strictEqual(rollups.length, 1);
    assert.strictEqual(rollups[0].date, "2026-09-05");
    assert.strictEqual(rollups[0].used, 0);
    assert.strictEqual(rollups[0].endRemaining, 280);
    assert.strictEqual(rollups[0].samples, 1);
  });

  test("accumulates drops into the day and its hour block", () => {
    let rollups = observe([], localIso(2026, 9, 5, 9), 300, null);
    rollups = observe(rollups, localIso(2026, 9, 5, 10), 290, 300);
    rollups = observe(rollups, localIso(2026, 9, 5, 14), 275, 290);

    assert.strictEqual(rollups.length, 1);
    assert.strictEqual(rollups[0].used, 25);
    assert.strictEqual(rollups[0].endRemaining, 275);
    assert.strictEqual(rollups[0].samples, 3);
    // 10:00 falls in block 2 (08:00-12:00), 14:00 in block 3 (12:00-16:00).
    assert.strictEqual(rollups[0].blocks[2], 10);
    assert.strictEqual(rollups[0].blocks[3], 15);
  });

  test("keeps one rollup per day, ascending by date", () => {
    let rollups = observe([], localIso(2026, 9, 5, 10), 300, null);
    rollups = observe(rollups, localIso(2026, 9, 6, 10), 280, 300);
    rollups = observe(rollups, localIso(2026, 9, 7, 10), 250, 280);

    assert.deepStrictEqual(
      rollups.map((r) => r.date),
      ["2026-09-05", "2026-09-06", "2026-09-07"]
    );
    assert.deepStrictEqual(rollups.map((r) => r.used), [0, 20, 30]);
  });

  test("inserts an out-of-order day in the right place", () => {
    let rollups = observe([], localIso(2026, 9, 7, 10), 250, null);
    rollups = observe(rollups, localIso(2026, 9, 5, 10), 300, null);

    assert.deepStrictEqual(
      rollups.map((r) => r.date),
      ["2026-09-05", "2026-09-07"]
    );
  });

  test("records a quota reset without counting it as usage", () => {
    let rollups = observe([], localIso(2026, 9, 5, 10), 20, null);
    // Balance jumps back up at the reset.
    rollups = observe(rollups, localIso(2026, 9, 5, 11), 300, 20);

    assert.strictEqual(rollups[0].used, 0);
    assert.strictEqual(rollups[0].endRemaining, 300);
  });

  test("ignores an unparseable timestamp", () => {
    const rollups = observe([], "not-a-date", 100, 200);
    assert.deepStrictEqual(rollups, []);
  });

  test("trims to the retention limit, dropping the oldest days", () => {
    let rollups: DailyRollup[] = [];
    let previous: number | null = null;
    for (let i = 0; i < MAX_DAILY_ROLLUPS + 5; i++) {
      const day = new Date(2024, 0, 1 + i, 12, 0, 0);
      const remaining = 100000 - i;
      rollups = foldObservation(
        rollups,
        { timestamp: day.toISOString(), remaining, entitlement: 300 },
        previous
      );
      previous = remaining;
    }

    assert.strictEqual(rollups.length, MAX_DAILY_ROLLUPS);
    // The first five days fell off the front.
    assert.strictEqual(rollups[0].date, localDateKey(new Date(2024, 0, 6, 12, 0, 0)));
  });

  test("does not mutate the input list", () => {
    const original = observe([], localIso(2026, 9, 5, 10), 300, null);
    const snapshotOfOriginal = JSON.parse(JSON.stringify(original));

    observe(original, localIso(2026, 9, 5, 11), 290, 300);

    assert.deepStrictEqual(original, snapshotOfOriginal);
  });
});

suite("buildRollupsFromSnapshots", () => {
  test("rebuilds daily usage from newest-first raw history", () => {
    // Newest first, as stored.
    const snapshots: LocalSnapshot[] = [
      { timestamp: localIso(2026, 9, 6, 15), premium_remaining: 240, premium_entitlement: 300 },
      { timestamp: localIso(2026, 9, 6, 9), premium_remaining: 260, premium_entitlement: 300 },
      { timestamp: localIso(2026, 9, 5, 17), premium_remaining: 280, premium_entitlement: 300 },
      { timestamp: localIso(2026, 9, 5, 9), premium_remaining: 300, premium_entitlement: 300 },
    ];

    const rollups = buildRollupsFromSnapshots(snapshots);

    assert.deepStrictEqual(
      rollups.map((r) => r.date),
      ["2026-09-05", "2026-09-06"]
    );
    // Day 1: 300 -> 280 = 20 used. Day 2: 280 -> 260 -> 240 = 40 used.
    assert.deepStrictEqual(rollups.map((r) => r.used), [20, 40]);
  });

  test("returns an empty list for empty history", () => {
    assert.deepStrictEqual(buildRollupsFromSnapshots([]), []);
  });
});

suite("getUsedTodayFromRollups", () => {
  const now = new Date(2026, 8, 6, 15, 0, 0);

  test("returns today's recorded usage", () => {
    let rollups = observe([], localIso(2026, 9, 5, 10), 300, null);
    rollups = observe(rollups, localIso(2026, 9, 6, 10), 280, 300);

    assert.strictEqual(getUsedTodayFromRollups(rollups, now), 20);
  });

  test("returns zero for a day observed without usage", () => {
    const rollups = observe([], localIso(2026, 9, 6, 10), 300, 300);
    assert.strictEqual(getUsedTodayFromRollups(rollups, now), 0);
  });

  test("returns null when today has not been observed", () => {
    const rollups = observe([], localIso(2026, 9, 5, 10), 300, null);
    assert.strictEqual(getUsedTodayFromRollups(rollups, now), null);
  });
});

suite("summarizePeriod", () => {
  const period: CurrentPeriod = {
    resetDate: "2026-10-01T00:00:00Z",
    startDate: "2026-09-05",
    partial: false,
  };

  function threeDays(): DailyRollup[] {
    let rollups = observe([], localIso(2026, 9, 4, 10), 300, null);
    rollups = observe(rollups, localIso(2026, 9, 5, 10), 290, 300); // 10 used
    rollups = observe(rollups, localIso(2026, 9, 6, 10), 240, 290); // 50 used
    rollups = observe(rollups, localIso(2026, 9, 7, 10), 220, 240); // 20 used
    return rollups;
  }

  test("totals only the days inside the period", () => {
    const summary = summarizePeriod(threeDays(), period, 300);

    assert.ok(summary);
    assert.strictEqual(summary.totalUsed, 80);
    assert.strictEqual(summary.daysObserved, 3);
    assert.strictEqual(summary.startDate, "2026-09-05");
    assert.strictEqual(summary.endDate, "2026-09-07");
  });

  test("identifies the busiest day", () => {
    const summary = summarizePeriod(threeDays(), period, 300);

    assert.strictEqual(summary?.peakDayDate, "2026-09-06");
    assert.strictEqual(summary?.peakDayUsed, 50);
  });

  test("closes the period at the given end date", () => {
    const summary = summarizePeriod(threeDays(), period, 300, "2026-09-06");

    assert.strictEqual(summary?.totalUsed, 60);
    assert.strictEqual(summary?.endDate, "2026-09-06");
  });

  test("reports overage from a negative closing balance", () => {
    let rollups = observe([], localIso(2026, 9, 5, 10), 10, null);
    rollups = observe(rollups, localIso(2026, 9, 6, 10), -25, 10);

    const summary = summarizePeriod(rollups, period, 300);
    assert.strictEqual(summary?.overageCredits, 25);
  });

  test("returns null when the period has no observed days", () => {
    const rollups = observe([], localIso(2026, 9, 1, 10), 300, null);
    assert.strictEqual(summarizePeriod(rollups, period, 300), null);
  });

  test("carries the period's partial flag", () => {
    const summary = summarizePeriod(threeDays(), { ...period, partial: true }, 300);
    assert.strictEqual(summary?.partial, true);
  });
});

suite("rollupsInPeriod", () => {
  test("filters by start and optional end date", () => {
    let rollups = observe([], localIso(2026, 9, 4, 10), 300, null);
    rollups = observe(rollups, localIso(2026, 9, 5, 10), 290, 300);
    rollups = observe(rollups, localIso(2026, 9, 6, 10), 280, 290);

    assert.deepStrictEqual(
      rollupsInPeriod(rollups, "2026-09-05").map((r) => r.date),
      ["2026-09-05", "2026-09-06"]
    );
    assert.deepStrictEqual(
      rollupsInPeriod(rollups, "2026-09-04", "2026-09-05").map((r) => r.date),
      ["2026-09-04", "2026-09-05"]
    );
  });
});

suite("comparePeriods", () => {
  const base = {
    resetDate: "2026-10-01T00:00:00Z",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    entitlement: 300,
    peakDayDate: "2026-09-10",
    peakDayUsed: 40,
    overageCredits: 0,
    partial: false,
  };

  test("computes the delta and percentage against the previous period", () => {
    const comparison = comparePeriods(
      { ...base, totalUsed: 150, daysObserved: 10 },
      { ...base, totalUsed: 100, daysObserved: 10 }
    );

    assert.strictEqual(comparison.usedDelta, 50);
    assert.strictEqual(comparison.usedDeltaPercent, 50);
    assert.strictEqual(comparison.avgPerDay, 15);
    assert.strictEqual(comparison.previousAvgPerDay, 10);
  });

  test("reports a decrease as a negative delta", () => {
    const comparison = comparePeriods(
      { ...base, totalUsed: 80, daysObserved: 8 },
      { ...base, totalUsed: 100, daysObserved: 8 }
    );

    assert.strictEqual(comparison.usedDelta, -20);
    assert.strictEqual(comparison.usedDeltaPercent, -20);
  });

  test("omits the comparison when there is no previous period", () => {
    const comparison = comparePeriods({ ...base, totalUsed: 150, daysObserved: 10 }, null);

    assert.strictEqual(comparison.previous, null);
    assert.strictEqual(comparison.usedDelta, null);
    assert.strictEqual(comparison.usedDeltaPercent, null);
    assert.strictEqual(comparison.avgPerDay, 15);
  });

  test("omits the percentage when the previous period used nothing", () => {
    const comparison = comparePeriods(
      { ...base, totalUsed: 50, daysObserved: 5 },
      { ...base, totalUsed: 0, daysObserved: 5 }
    );

    assert.strictEqual(comparison.usedDelta, 50);
    assert.strictEqual(comparison.usedDeltaPercent, null);
  });

  test("flags uneven coverage between the periods", () => {
    const even = comparePeriods(
      { ...base, totalUsed: 150, daysObserved: 10 },
      { ...base, totalUsed: 100, daysObserved: 10 }
    );
    const uneven = comparePeriods(
      { ...base, totalUsed: 150, daysObserved: 4 },
      { ...base, totalUsed: 100, daysObserved: 10 }
    );

    assert.strictEqual(even.unevenCoverage, false);
    assert.strictEqual(uneven.unevenCoverage, true);
  });
});
