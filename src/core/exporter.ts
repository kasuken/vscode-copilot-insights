import { LocalSnapshot } from "../types";

export type ExportFormat = "json" | "csv";

/**
 * Serializes the local snapshot history for export.
 * JSON exports the full snapshot objects; CSV exports
 * `timestamp,premium_remaining,premium_entitlement` rows.
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
