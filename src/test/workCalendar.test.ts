import * as assert from "assert";
import { workdayCapacity, WorkCalendarOptions } from "../core/workCalendar";

const defaults: WorkCalendarOptions = { weekdays: [1, 2, 3, 4, 5], daysOff: [], reserve: 0, personalBudget: 0 };

suite("Working calendar capacity", () => {
  test("counts local workdays including today, excluding days off and reset midnight", () => {
    const now = new Date(2026, 9, 19, 12); // Monday
    const reset = new Date(2026, 9, 26).toISOString();
    assert.deepStrictEqual(workdayCapacity(100, 100, reset, defaults, now), { days: 5, spendable: 100, perDay: 20 });
    assert.deepStrictEqual(workdayCapacity(100, 100, reset, { ...defaults, daysOff: ["2026-10-20"], reserve: 20 }, now),
      { days: 4, spendable: 80, perDay: 20 });
  });

  test("personal target below allowance reduces capacity, not reported usage", () => {
    const now = new Date(2026, 9, 19);
    const reset = new Date(2026, 9, 26).toISOString();
    assert.strictEqual(workdayCapacity(250, 50, reset, { ...defaults, personalBudget: 100, reserve: 10 }, now).spendable, 40);
    assert.strictEqual(workdayCapacity(250, 150, reset, { ...defaults, personalBudget: 100 }, now).spendable, 0);
    assert.strictEqual(workdayCapacity(250, 50, reset, { ...defaults, personalBudget: 1000 }, now).spendable, 250);
  });

  test("empty working week, exhausted capacity and invalid or past dates are finite and nonnegative", () => {
    const now = new Date(2026, 9, 19);
    for (const reset of ["invalid", "2020-01-01", now.toISOString()]) {
      assert.strictEqual(workdayCapacity(100, 10, reset, defaults, now).perDay, 0);
    }
    assert.strictEqual(workdayCapacity(NaN, 0, "2026-11-01", defaults, now).spendable, 0);
    assert.strictEqual(workdayCapacity(-50, 500, "2026-11-01", defaults, now).perDay, 0);
    assert.strictEqual(workdayCapacity(100, 10, "2026-11-01", { ...defaults, weekdays: [] }, now).perDay, 0);
    assert.strictEqual(workdayCapacity(100, 10, "2026-11-01", { ...defaults, reserve: Infinity }, now).spendable, 100);
  });

  test("invalid weekdays and days off have no effect; duplicate weekdays do not double-count", () => {
    const result = workdayCapacity(100, 0, new Date(2026, 9, 26).toISOString(), {
      ...defaults, weekdays: [1, 1, 8, -1, 1.5], daysOff: ["2026-02-30", "2026-10-99", "not-a-date"],
    }, new Date(2026, 9, 19));
    assert.strictEqual(result.days, 1);
  });

  test("calendar iteration spans DST boundaries without skipping or duplicating dates", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      for (const [month, first, last] of [[2, 7, 10], [9, 31, 34]]) {
        const now = new Date(2026, month, first, 12);
        const reset = new Date(2026, month, last).toISOString();
        assert.strictEqual(workdayCapacity(90, 0, reset, { ...defaults, weekdays: [0, 1, 2, 3, 4, 5, 6] }, now).days, 3);
      }
    } finally {
      if (previous === undefined) { delete process.env.TZ; } else { process.env.TZ = previous; }
    }
  });

  test("far-future reset dates remain bounded", () => {
    assert.ok(workdayCapacity(100, 0, "9999-01-01", defaults, new Date()).days <= 366);
  });
});
