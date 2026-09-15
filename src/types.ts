export interface Organization {
  login: string;
  name: string;
}

export interface QuotaSnapshot {
  quota_id: string;
  timestamp_utc: string;
  entitlement: number;
  quota_remaining: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
  overage_permitted: boolean;
  overage_count: number;
  has_quota?: boolean;
  quota_reset_at?: number;
  token_based_billing?: boolean;
}

export interface CopilotUserData {
  login: string;
  copilot_plan: string;
  chat_enabled: boolean;
  cli_enabled: boolean;
  is_mcp_enabled: boolean;
  editor_preview_features_enabled: boolean;
  copilotignore_enabled: boolean;
  restricted_telemetry: boolean;
  access_type_sku: string;
  assigned_date: string;
  organization_list: Organization[];
  quota_snapshots: {
    [key: string]: QuotaSnapshot;
  };
  quota_reset_date_utc: string;
  quota_reset_date: string;
  token_based_billing?: boolean;
  analytics_tracking_id?: string;
}

export interface LocalSnapshot {
  timestamp: string;
  premium_remaining: number;
  premium_entitlement: number;
}

export interface StatusBadge {
  emoji: string;
  icon: string;
  label: string;
  color: string;
}

export interface QuotaStats {
  used: number;
  isOverQuota: boolean;
  percentRemaining: number;
  percentUsed: number;
  overageAmount: number;
}

export interface TimeUntilReset {
  days: number;
  hours: number;
  totalDays: number;
}

/**
 * A calendar day of AI credit usage, aggregated from raw snapshots.
 *
 * Rollups are the durable tier of history: raw snapshots are pruned after a
 * couple of days, but one rollup per day survives for the whole billing
 * period (and well beyond), so the burn-down, heatmap, and forecasts keep
 * covering the full window no matter how heavily Copilot is used.
 */
export interface DailyRollup {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Credits consumed during this day (sum of positive deltas). */
  used: number;
  /** Remaining balance at the last observation of the day. */
  endRemaining: number;
  /** Entitlement observed on this day. */
  entitlement: number;
  /** Raw observations folded into this rollup. */
  samples: number;
  /**
   * Usage split across the day's 4-hour blocks (index 0 = 00:00-04:00).
   * Always `HEATMAP_HOUR_BLOCKS` entries long.
   */
  blocks: number[];
}

/** A closed billing period, archived when the quota reset date rolls over. */
export interface PeriodSummary {
  /** The reset date (UTC ISO) that closed this period — its identity. */
  resetDate: string;
  /** First local date observed in the period (`YYYY-MM-DD`). */
  startDate: string;
  /** Last local date observed in the period (`YYYY-MM-DD`). */
  endDate: string;
  /** Plan entitlement for the period. */
  entitlement: number;
  /** Total credits consumed across the period. */
  totalUsed: number;
  /** Date of the heaviest day (`YYYY-MM-DD`), or `""` when nothing was used. */
  peakDayDate: string;
  /** Credits used on the heaviest day. */
  peakDayUsed: number;
  /** Days with at least one observation. */
  daysObserved: number;
  /** Credits consumed beyond the entitlement, when known. */
  overageCredits: number;
  /**
   * True when tracking began after the period had already started, so
   * `totalUsed` covers only part of it.
   */
  partial: boolean;
  /**
   * Per-project credit attribution for the period, kept when attribution was
   * enabled. Absent on periods archived before attribution existed, or while
   * it was turned off.
   */
  attribution?: AttributionBucket[];
}

/**
 * Credits attributed to one project (and optionally one branch) during a
 * billing period.
 *
 * Attribution is inferred locally: GitHub reports a balance, never what spent
 * it, so a drop is credited to whatever project this window had in the
 * foreground for the whole interval. It is an estimate, never an audit.
 */
export interface AttributionBucket {
  /** Workspace folder name, or `""` when no folder was open. */
  project: string;
  /** Git branch at the time, or `""` when unknown or not tracked. */
  branch: string;
  /** Credits attributed to this project and branch. */
  credits: number;
  /** Local date (`YYYY-MM-DD`) of the most recent attribution. */
  lastDate: string;
}

/**
 * Attribution state for the billing period in progress.
 *
 * Only *attributed* credits are stored. The unattributed remainder is derived
 * at display time from the period total, so a second VS Code window observing
 * the same usage can never inflate the numbers.
 */
export interface AttributionState {
  /** Reset date (UTC ISO) of the period these buckets belong to. */
  resetDate: string;
  /** Per project-and-branch totals, in no particular order. */
  buckets: AttributionBucket[];
}

/** How much context credit attribution records. */
export type AttributionMode = "project-and-branch" | "project" | "off";

/** The billing period currently being tracked. */
export interface CurrentPeriod {
  /** Reset date (UTC ISO) of the period in progress. */
  resetDate: string;
  /** First local date tracked in this period (`YYYY-MM-DD`). */
  startDate: string;
  /** True when tracking began mid-period. */
  partial: boolean;
}

export const SNAPSHOT_HISTORY_KEY = "copilotInsights.snapshotHistory";
export const DAILY_ROLLUP_KEY = "copilotInsights.dailyRollups";
export const PERIOD_SUMMARY_KEY = "copilotInsights.periodSummaries";
export const CURRENT_PERIOD_KEY = "copilotInsights.currentPeriod";
export const ATTRIBUTION_KEY = "copilotInsights.attribution";

/**
 * Raw snapshots are retained for this many hours. Older ones are pruned
 * because their information now lives in the daily rollups.
 */
export const RAW_RETENTION_HOURS = 48;
/**
 * Raw snapshots always kept regardless of age, so light users (who may record
 * only a handful of snapshots a week) keep a usable recent window.
 */
export const MIN_RAW_SNAPSHOTS = 30;
/** Hard ceiling on retained raw snapshots, to bound global-state size. */
export const MAX_RAW_SNAPSHOTS = 500;
/** Daily rollups retained (~13 months). */
export const MAX_DAILY_ROLLUPS = 400;
/** Archived billing periods retained. */
export const MAX_PERIOD_SUMMARIES = 24;
/**
 * Attribution buckets retained per period. Branches are merged away before
 * any project is dropped, so this is only reachable with a very large number
 * of distinct projects.
 */
export const MAX_ATTRIBUTION_BUCKETS = 200;
/** Projects kept on an archived period summary. */
export const MAX_ARCHIVED_ATTRIBUTION = 10;
// Under GitHub's AI Credits billing model, 1 AI credit costs $0.01 USD.
export const CREDIT_COST_USD = 0.01;
export const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
