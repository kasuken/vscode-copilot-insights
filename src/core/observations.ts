import type { Memento } from "vscode";
import { randomUUID } from "node:crypto";
import { AttributionContext } from "./attribution";
import { AttributionMode } from "../types";

const PREFIX = "copilotInsights.observations.v1.";
// Keep invalidation markers outside the history namespace: deleting history must
// not delete the evidence that cached (or delayed) writes are obsolete.
const CLEAR_PREFIX = "copilotInsights.observationClear.v1.";
const POLICY_KEY = "copilotInsights.observationPolicy.v1";
const MAX_INTERVALS = 5000;
export const MAX_OBSERVATION_GAP_MS = 5 * 60_000;

export interface UsageInterval {
  start: number;
  end: number;
  credits: number;
  gap: boolean;
  project?: string;
  branch?: string;
}

interface Anchor {
  time: number;
  remaining: number;
  entitlement: number;
  period: string;
}

export interface ObservationState {
  intervals: UsageInterval[];
  anchor?: Anchor;
  firstObserved?: number;
  lastChange?: number;
  gaps: number;
  cooldownUntil?: number;
}

export interface SpikeOptions {
  enabled: boolean;
  credits: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

interface StoredObservations extends ObservationState {
  generation?: string;
  policyGeneration?: string;
}

interface ObservationPolicy {
  generation: string;
  retention: number;
  mode: AttributionMode;
}

export function boundedNumber(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Complete contiguous observation intervals, including zero-spend polls.
 * Never extrapolates a partial window or treats delayed observations as bursts.
 */
export function spikeWindow(intervals: readonly UsageInterval[], minutes: number): UsageInterval | undefined {
  const last = intervals.at(-1);
  if (!last || last.credits <= 0) { return undefined; }
  const cutoff = last.end - boundedNumber(minutes, 5, 1, 60) * 60_000;
  let start = last.end;
  let credits = 0;
  for (let i = intervals.length - 1; i >= 0; i--) {
    const interval = intervals[i];
    if (!Number.isFinite(interval.credits) || interval.credits < 0 ||
        !Number.isFinite(interval.start) || !Number.isFinite(interval.end) ||
        interval.gap || interval.end !== start || interval.end <= interval.start ||
        interval.end - interval.start > MAX_OBSERVATION_GAP_MS) { return undefined; }
    start = interval.start;
    credits += interval.credits;
    if (start <= cutoff) {
      return { start, end: last.end, credits: Math.round(credits * 100) / 100, gap: false };
    }
  }
  return undefined;
}

/** Separate from deduplicated raw history: every successful poll advances the anchor. */
export class ObservationStore {
  private account = "";
  private state: ObservationState = { intervals: [], gaps: 0 };
  private interrupted = true;
  private retention = 7;
  private mode: AttributionMode = "project-and-branch";
  private generation?: string;
  private policyGeneration?: string;

  constructor(private readonly storage: Memento) {}

  setAccount(account: string): void {
    this.synchronize();
    if (account === this.account) { return; }
    this.account = account;
    this.generation = this.storage.get<string>(CLEAR_PREFIX + account);
    this.state = this.load(account);
    this.interrupted = true;
    this.prune(Date.now());
  }

  /**
   * Privacy and retention changes also apply to accounts not currently selected.
   * Explicit configure calls establish the shared policy; cached readers/writers
   * adopt it on their next operation (subject to Memento visibility).
   */
  configure(days: number, mode: AttributionMode, now = Date.now()): void {
    this.synchronize();
    const previousPolicyGeneration = this.policyGeneration;
    this.retention = Math.floor(boundedNumber(days, 7, 0, 30));
    this.mode = mode;
    const policy = this.storage.get<ObservationPolicy>(POLICY_KEY);
    if (this.retention !== (policy?.retention ?? 7) || mode !== (policy?.mode ?? "project-and-branch")) {
      this.policyGeneration = randomUUID();
      void this.storage.update(POLICY_KEY, {
        generation: this.policyGeneration, retention: this.retention, mode,
      } satisfies ObservationPolicy);
    }
    for (const key of this.storage.keys().filter(key => key.startsWith(PREFIX))) {
      const saved = this.storage.get<StoredObservations>(key);
      if (!saved) { continue; }
      const generation = this.storage.get<string>(CLEAR_PREFIX + key.slice(PREFIX.length));
      const valid = saved.generation === generation && saved.policyGeneration === previousPolicyGeneration;
      const cleaned = { ...this.clean(saved, now), policyGeneration: this.policyGeneration };
      void this.storage.update(key, this.retention === 0 || !valid ? undefined : cleaned);
    }
    this.prune(now);
  }

  private clean(state: ObservationState, now: number): ObservationState {
    return {
      ...state,
      intervals: state.intervals
        .filter(i => i.end >= now - this.retention * 86400_000)
        .slice(-MAX_INTERVALS)
        .map(i => ({
          ...i,
          project: this.mode === "off" ? undefined : i.project,
          branch: this.mode === "project-and-branch" ? i.branch : undefined,
        })),
    };
  }

  private prune(now: number): void {
    this.synchronize();
    this.state = this.retention === 0 ? { intervals: [], gaps: 0 } : this.clean(this.state, now);
    this.save();
  }

  private save(): void {
    this.synchronize();
    if (this.account) {
      void this.storage.update(PREFIX + this.account, this.retention === 0 ? undefined : {
        ...this.state, generation: this.generation, policyGeneration: this.policyGeneration,
      } satisfies StoredObservations);
    }
  }

  private load(account: string): ObservationState {
    const saved = this.storage.get<StoredObservations>(PREFIX + account);
    if (this.retention === 0 || !saved || saved.generation !== this.generation ||
        saved.policyGeneration !== this.policyGeneration) { return { intervals: [], gaps: 0 }; }
    return { ...saved, intervals: saved.intervals.map(interval => ({ ...interval })) };
  }

  /**
   * Memento has no atomic compare-and-swap or cross-window read freshness
   * guarantee. Recheck the markers visible to this instance before reads/writes;
   * stamped records also reject late obsolete writes once markers are visible.
   * This is invalidation, not transactional multi-window history or spike claims.
   */
  private synchronize(): void {
    const policy = this.storage.get<ObservationPolicy>(POLICY_KEY);
    const generation = this.storage.get<string>(CLEAR_PREFIX + this.account);
    if (generation === this.generation && policy?.generation === this.policyGeneration) { return; }
    this.generation = generation;
    this.policyGeneration = policy?.generation;
    this.retention = policy?.retention ?? 7;
    this.mode = policy?.mode ?? "project-and-branch";
    this.state = this.load(this.account);
    this.interrupted = true;
  }

  get data(): Readonly<ObservationState> { this.synchronize(); return this.state; }
  get enabled(): boolean { this.synchronize(); return this.retention > 0; }
  get trackingInterrupted(): boolean { return this.enabled && this.interrupted && !!this.state.anchor; }
  interrupt(): void { this.interrupted = true; }

  clear(): void {
    this.synchronize();
    this.state = { intervals: [], gaps: 0 };
    this.interrupted = true;
    if (this.account) {
      this.generation = randomUUID();
      void this.storage.update(CLEAR_PREFIX + this.account, this.generation);
      void this.storage.update(PREFIX + this.account, undefined);
    }
  }

  observe(remaining: number, entitlement: number, period: string, time: number, context?: AttributionContext): UsageInterval | undefined {
    if (!this.account || !this.enabled) { return undefined; }
    if (!Number.isFinite(remaining) || !Number.isFinite(entitlement) || entitlement <= 0 ||
        Math.abs(remaining) > Number.MAX_SAFE_INTEGER || entitlement > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(new Date(time).getTime()) || !period || !Number.isFinite(Date.parse(period))) {
      this.interrupt();
      return undefined;
    }
    const previous = this.state.anchor;
    // Repeated/out-of-order timestamps cannot describe a real interval.
    if (previous && time <= previous.time) { this.interrupt(); return undefined; }
    let interval: UsageInterval | undefined;
    const boundary = previous && (previous.period !== period || previous.entitlement !== entitlement || remaining > previous.remaining);
    if (boundary) {
      // Keep recent history, but leave a discontinuity between billing epochs.
      // A new spike window must consist entirely of post-boundary intervals.
      if (remaining !== previous.remaining) { this.state.lastChange = time; }
      if (this.interrupted || time - previous.time > MAX_OBSERVATION_GAP_MS) { this.state.gaps++; }
    } else if (previous) {
      const gap = this.interrupted || time - previous.time > MAX_OBSERVATION_GAP_MS;
      const credits = Math.round(Math.max(0, previous.remaining - remaining) * 100) / 100;
      interval = { start: previous.time, end: time, credits, gap };
      if (credits > 0 && !gap && this.mode !== "off" && context?.attributable && context.project) {
        interval.project = context.project.slice(0, 200);
        if (this.mode === "project-and-branch" && context.branch) { interval.branch = context.branch.slice(0, 200); }
      }
      this.state.intervals = [...this.state.intervals, interval];
      if (gap) { this.state.gaps++; }
      if (remaining !== previous.remaining) { this.state.lastChange = time; }
    }
    this.state.firstObserved ??= time;
    this.state.anchor = { time, remaining, entitlement, period };
    this.interrupted = false;
    this.prune(time);
    return interval;
  }

  /** Claim before showing the notification, so idle polls and restarts cannot repeat it. */
  takeSpike(options: SpikeOptions): UsageInterval | undefined {
    if (!this.enabled || !options.enabled) { return undefined; }
    const window = spikeWindow(this.state.intervals, options.windowMinutes);
    if (!window || window.credits < boundedNumber(options.credits, 50, 0.01, 10_000_000) ||
        window.end <= (this.state.cooldownUntil ?? 0)) { return undefined; }
    this.state.cooldownUntil = window.end + boundedNumber(options.cooldownMinutes, 30, 1, 1440) * 60_000;
    this.save();
    return window;
  }
}
