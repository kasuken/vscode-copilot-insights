import { boundedNumber } from "./observations";

export interface WorkCalendarOptions {
  weekdays: number[];
  daysOff: string[];
  reserve: number;
  personalBudget: number;
}

/** Local calendar arithmetic, not 24-hour division (DST days are not all 24 hours). */
export function workdayCapacity(
  remaining: number, used: number, resetDate: string, options: WorkCalendarOptions, now = new Date()
): { days: number; spendable: number; perDay: number } {
  const reset = new Date(resetDate);
  const weekdays = new Set(options.weekdays.slice(0, 7).filter(day => Number.isInteger(day) && day >= 0 && day <= 6));
  const daysOff = new Set(options.daysOff.slice(0, 366).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)));
  const target = boundedNumber(options.personalBudget, 0, 0, 10_000_000);
  const available = target > 0 ? Math.min(remaining, target - used) : remaining;
  const spendable = Math.max(0, (Number.isFinite(available) ? available : 0) - boundedNumber(options.reserve, 0, 0, 10_000_000));
  let days = 0;
  if (Number.isFinite(now.getTime()) && Number.isFinite(reset.getTime()) && reset > now) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // A monthly reset should be close; cap malformed far-future dates.
    for (let count = 0; count < 366 && day < reset; count++, day.setDate(day.getDate() + 1)) {
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      if (weekdays.has(day.getDay()) && !daysOff.has(key)) { days++; }
    }
  }
  return { days, spendable, perDay: days > 0 ? spendable / days : 0 };
}
