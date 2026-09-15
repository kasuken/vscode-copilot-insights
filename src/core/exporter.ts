import { AttributionState, DailyRollup, LocalSnapshot, PeriodSummary } from "../types";

export type ExportFormat = "json" | "csv";

/** Escapes a CSV field, quoting only when needed. */
function csvField(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serializes the raw snapshot history for export.
 * JSON exports the full snapshot objects; CSV exports
 * `timestamp,premium_remaining,premium_entitlement` rows.
 *
 * Raw snapshots cover only the recent retention window — use
 * {@link serializeRollups} for the full billing period.
 */
export function serializeHistory(
  history: readonly LocalSnapshot[],
  format: ExportFormat
): string {
  if (format === "json") {
    return JSON.stringify(history, null, 2);
  }

  return [
    "timestamp,premium_remaining,premium_entitlement",
    ...history.map((s) => `${s.timestamp},${s.premium_remaining},${s.premium_entitlement}`),
  ].join("\n");
}

/**
 * Serializes the daily usage rollups, which span the whole billing period.
 * CSV exports one row per day, with the per-4-hour-block split flattened into
 * `block_0`…`block_5` columns.
 */
export function serializeRollups(
  rollups: readonly DailyRollup[],
  format: ExportFormat
): string {
  if (format === "json") {
    return JSON.stringify(rollups, null, 2);
  }

  const blockCount = rollups.reduce((max, r) => Math.max(max, r.blocks.length), 0);
  const blockHeaders = Array.from({ length: blockCount }, (_, i) => `block_${i}`);

  return [
    ["date", "used", "end_remaining", "entitlement", "samples", ...blockHeaders].join(","),
    ...rollups.map((r) =>
      [
        r.date,
        r.used,
        r.endRemaining,
        r.entitlement,
        r.samples,
        ...Array.from({ length: blockCount }, (_, i) => r.blocks[i] ?? 0),
      ]
        .map(csvField)
        .join(",")
    ),
  ].join("\n");
}

/**
 * Serializes the current period's credit attribution, largest first.
 * CSV exports one row per project and branch.
 */
export function serializeAttribution(
  state: AttributionState | undefined,
  format: ExportFormat
): string {
  const buckets = [...(state?.buckets ?? [])].sort((a, b) => b.credits - a.credits);

  if (format === "json") {
    return JSON.stringify({ resetDate: state?.resetDate ?? "", buckets }, null, 2);
  }

  return [
    ["project", "branch", "credits", "last_date"].join(","),
    ...buckets.map((bucket) =>
      [bucket.project, bucket.branch, bucket.credits, bucket.lastDate].map(csvField).join(",")
    ),
  ].join("\n");
}

/** Serializes the archive of completed billing periods. */
export function serializePeriods(
  periods: readonly PeriodSummary[],
  format: ExportFormat
): string {
  if (format === "json") {
    return JSON.stringify(periods, null, 2);
  }

  return [
    [
      "reset_date",
      "start_date",
      "end_date",
      "entitlement",
      "total_used",
      "peak_day_date",
      "peak_day_used",
      "days_observed",
      "overage_credits",
      "partial",
    ].join(","),
    ...periods.map((p) =>
      [
        p.resetDate,
        p.startDate,
        p.endDate,
        p.entitlement,
        p.totalUsed,
        p.peakDayDate,
        p.peakDayUsed,
        p.daysObserved,
        p.overageCredits,
        p.partial,
      ]
        .map(csvField)
        .join(",")
    ),
  ].join("\n");
}
