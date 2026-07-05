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

export const SNAPSHOT_HISTORY_KEY = "copilotInsights.snapshotHistory";
export const MAX_SNAPSHOTS = 90;
// Under GitHub's AI Credits billing model, 1 AI credit costs $0.01 USD.
export const CREDIT_COST_USD = 0.01;
export const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
