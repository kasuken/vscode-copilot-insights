import {
  AttributionBucket,
  AttributionState,
  MAX_ARCHIVED_ATTRIBUTION,
  MAX_ATTRIBUTION_BUCKETS,
} from "../types";

/**
 * Credit attribution: which project a drop in the balance is credited to.
 *
 * GitHub reports how many AI credits are left, never what spent them. The only
 * local signal is timing: when the balance drops while one project has been in
 * the foreground of this window for the whole interval, that project is the
 * overwhelmingly likely cause. So attribution is an estimate — good enough to
 * answer "where is my quota going?", not an audit trail.
 *
 * Two rules keep the estimate honest:
 *
 * - A delta is only attributed when the window stayed focused across the whole
 *   interval. Anything else (another window, VS Code in the background, the
 *   Copilot CLI, github.com) is left out rather than guessed at.
 * - Only attributed credits are stored. The unattributed remainder is derived
 *   from the period total at display time, so a second window observing the
 *   same usage cannot inflate the totals.
 */

/** Rounds to two decimals, keeping accumulated floats from drifting. */
function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

/** The foreground context a credit delta is attributed to. */
export interface AttributionContext {
  /** Workspace folder name, or `""` when no folder is open. */
  project: string;
  /** Git branch, or `""` when unknown or branch tracking is off. */
  branch: string;
  /**
   * False when this window cannot account for the whole interval — it was
   * unfocused for part of it, so the usage may belong to another window or to
   * Copilot outside the editor.
   */
  attributable: boolean;
}

/** An empty attribution state for a billing period. */
export function emptyAttribution(resetDate: string): AttributionState {
  return { resetDate, buckets: [] };
}

/**
 * Merges every branch of a project into a single branch-less bucket. Used to
 * shed cardinality without losing the project-level totals, which are what the
 * breakdown actually leads with.
 */
function collapseBranches(buckets: readonly AttributionBucket[]): AttributionBucket[] {
  const byProject = new Map<string, AttributionBucket>();

  for (const bucket of buckets) {
    const existing = byProject.get(bucket.project);
    if (existing) {
      existing.credits = round2(existing.credits + bucket.credits);
      if (bucket.lastDate > existing.lastDate) {
        existing.lastDate = bucket.lastDate;
      }
    } else {
      byProject.set(bucket.project, { ...bucket, branch: "" });
    }
  }

  return [...byProject.values()];
}

/**
 * Enforces the bucket cap: branches are merged first, and only if that is
 * still not enough are the smallest projects dropped. Dropped credits are not
 * moved anywhere — they simply fall back into the derived unattributed
 * remainder, which is the honest place for "we no longer know".
 */
function trimBuckets(buckets: readonly AttributionBucket[]): AttributionBucket[] {
  if (buckets.length <= MAX_ATTRIBUTION_BUCKETS) {
    return [...buckets];
  }

  const collapsed = collapseBranches(buckets);
  if (collapsed.length <= MAX_ATTRIBUTION_BUCKETS) {
    return collapsed;
  }

  return [...collapsed]
    .sort((a, b) => b.credits - a.credits)
    .slice(0, MAX_ATTRIBUTION_BUCKETS);
}

/**
 * Folds a positive credit delta into the attribution state, returning a new
 * state. Non-positive deltas (idle polls, quota resets) and deltas the window
 * cannot account for are dropped.
 *
 * `date` is the local `YYYY-MM-DD` the delta was observed on.
 */
export function attributeCredits(
  state: AttributionState,
  credits: number,
  context: AttributionContext,
  date: string
): AttributionState {
  if (!context.attributable || !(credits > 0)) {
    return { ...state, buckets: [...state.buckets] };
  }

  const buckets = state.buckets.map((bucket) => ({ ...bucket }));
  const existing = buckets.find(
    (bucket) => bucket.project === context.project && bucket.branch === context.branch
  );

  if (existing) {
    existing.credits = round2(existing.credits + credits);
    existing.lastDate = date;
  } else {
    buckets.push({
      project: context.project,
      branch: context.branch,
      credits: round2(credits),
      lastDate: date,
    });
  }

  return { ...state, buckets: trimBuckets(buckets) };
}

/** One branch's share of a project. */
export interface BranchTotal {
  branch: string;
  credits: number;
}

/** One project's total across its branches. */
export interface ProjectTotal {
  project: string;
  credits: number;
  /** Percentage of the period total, 0-100. */
  share: number;
  /** Branches that contributed, largest first; empty when none were tracked. */
  branches: BranchTotal[];
}

/** The attribution breakdown for a billing period. */
export interface AttributionBreakdown {
  /** Projects, largest first, capped by `maxProjects`. */
  projects: ProjectTotal[];
  /** Projects that fell outside the cap, merged into one row. */
  otherProjects: number;
  /** Credits the window could not account for. */
  unattributed: number;
  /** Unattributed as a percentage of the period total, 0-100. */
  unattributedShare: number;
  /** Credits successfully attributed to a project. */
  attributed: number;
  /** The period total the shares are measured against. */
  total: number;
  /** Distinct projects seen, including any beyond the cap. */
  projectCount: number;
}

export interface AttributionBreakdownOptions {
  /** Projects listed individually before the rest merge into "other". */
  maxProjects?: number;
  /** Branches listed per project. */
  maxBranches?: number;
}

/**
 * Summarizes attribution against the period's total usage.
 *
 * `periodTotalCredits` comes from the daily rollups — the single source of
 * truth for how much was actually spent. The unattributed remainder is the
 * difference, so the parts always add up to the whole. Shares are measured
 * against whichever is larger of the two, so a double-counted attribution
 * (two windows, clock skew) can never push the bars past 100%.
 *
 * Returns null when there is nothing attributed to show.
 */
export function summarizeAttribution(
  state: AttributionState | undefined,
  periodTotalCredits: number,
  options: AttributionBreakdownOptions = {}
): AttributionBreakdown | null {
  const maxProjects = options.maxProjects ?? 5;
  const maxBranches = options.maxBranches ?? 3;

  if (!state || state.buckets.length === 0) {
    return null;
  }

  const byProject = new Map<string, { credits: number; branches: BranchTotal[] }>();
  let attributed = 0;

  for (const bucket of state.buckets) {
    if (!(bucket.credits > 0)) {
      continue;
    }
    attributed += bucket.credits;

    const entry = byProject.get(bucket.project) ?? { credits: 0, branches: [] };
    entry.credits += bucket.credits;
    if (bucket.branch) {
      entry.branches.push({ branch: bucket.branch, credits: round2(bucket.credits) });
    }
    byProject.set(bucket.project, entry);
  }

  if (byProject.size === 0) {
    return null;
  }

  attributed = round2(attributed);
  const total = round2(Math.max(periodTotalCredits, attributed));
  const share = (credits: number) => (total > 0 ? round2((credits / total) * 100) : 0);

  const ranked = [...byProject.entries()]
    .map(([project, entry]) => ({
      project,
      credits: round2(entry.credits),
      share: share(entry.credits),
      branches: entry.branches
        .sort((a, b) => b.credits - a.credits)
        .slice(0, maxBranches),
    }))
    .sort((a, b) => b.credits - a.credits);

  const projects = ranked.slice(0, maxProjects);
  const otherProjects = round2(
    ranked.slice(maxProjects).reduce((sum, entry) => sum + entry.credits, 0)
  );
  const unattributed = round2(Math.max(0, total - attributed));

  return {
    projects,
    otherProjects,
    unattributed,
    unattributedShare: share(unattributed),
    attributed,
    total,
    projectCount: ranked.length,
  };
}

/**
 * Condenses attribution for storage on an archived period summary: project
 * totals only, largest first, capped.
 */
export function archiveAttribution(
  state: AttributionState | undefined
): AttributionBucket[] | undefined {
  if (!state || state.buckets.length === 0) {
    return undefined;
  }

  const collapsed = collapseBranches(state.buckets)
    .filter((bucket) => bucket.credits > 0)
    .sort((a, b) => b.credits - a.credits)
    .slice(0, MAX_ARCHIVED_ATTRIBUTION);

  return collapsed.length > 0 ? collapsed : undefined;
}
