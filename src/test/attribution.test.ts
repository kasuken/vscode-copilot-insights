import * as assert from "assert";
import {
  archiveAttribution,
  attributeCredits,
  AttributionContext,
  emptyAttribution,
  summarizeAttribution,
} from "../core/attribution";
import { AttributionState, MAX_ARCHIVED_ATTRIBUTION, MAX_ATTRIBUTION_BUCKETS } from "../types";

const RESET = "2026-10-01T00:00:00Z";

function context(overrides: Partial<AttributionContext> = {}): AttributionContext {
  return { project: "api", branch: "main", attributable: true, ...overrides };
}

/** Folds a sequence of (credits, context) pairs into a fresh state. */
function build(
  entries: { credits: number; context?: Partial<AttributionContext>; date?: string }[]
): AttributionState {
  let state = emptyAttribution(RESET);
  for (const entry of entries) {
    state = attributeCredits(
      state,
      entry.credits,
      context(entry.context),
      entry.date ?? "2026-09-15"
    );
  }
  return state;
}

suite("attributeCredits", () => {
  test("creates a bucket for a new project and branch", () => {
    const state = build([{ credits: 12.5 }]);

    assert.strictEqual(state.buckets.length, 1);
    assert.deepStrictEqual(state.buckets[0], {
      project: "api",
      branch: "main",
      credits: 12.5,
      lastDate: "2026-09-15",
    });
  });

  test("accumulates into an existing project and branch", () => {
    const state = build([
      { credits: 10 },
      { credits: 5.25, date: "2026-09-16" },
    ]);

    assert.strictEqual(state.buckets.length, 1);
    assert.strictEqual(state.buckets[0].credits, 15.25);
    assert.strictEqual(state.buckets[0].lastDate, "2026-09-16");
  });

  test("keeps branches of the same project apart", () => {
    const state = build([
      { credits: 10 },
      { credits: 4, context: { branch: "feature/x" } },
    ]);

    assert.strictEqual(state.buckets.length, 2);
  });

  test("drops a delta the window cannot account for", () => {
    const state = build([{ credits: 40, context: { attributable: false } }]);

    assert.strictEqual(state.buckets.length, 0);
  });

  test("drops non-positive deltas", () => {
    // A quota reset raises the balance; an idle poll moves nothing.
    const state = build([{ credits: -300 }, { credits: 0 }]);

    assert.strictEqual(state.buckets.length, 0);
  });

  test("records usage with no folder open under an empty project", () => {
    const state = build([{ credits: 7, context: { project: "", branch: "" } }]);

    assert.strictEqual(state.buckets[0].project, "");
    assert.strictEqual(state.buckets[0].credits, 7);
  });

  test("does not mutate the input state", () => {
    const state = build([{ credits: 10 }]);
    const before = JSON.parse(JSON.stringify(state));

    attributeCredits(state, 5, context(), "2026-09-16");

    assert.deepStrictEqual(state, before);
  });

  test("stays within the bucket cap without losing credits", () => {
    let state = emptyAttribution(RESET);
    // One project, far more branches than the bucket cap allows. Branches are
    // merged away rather than dropped, so every credit survives.
    const entries = MAX_ATTRIBUTION_BUCKETS + 10;
    for (let i = 0; i < entries; i++) {
      state = attributeCredits(
        state,
        1,
        context({ project: "api", branch: `branch-${i}` }),
        "2026-09-15"
      );
    }

    assert.ok(
      state.buckets.length <= MAX_ATTRIBUTION_BUCKETS + 1,
      `expected the cap to hold, saw ${state.buckets.length} buckets`
    );
    assert.ok(state.buckets.every((bucket) => bucket.project === "api"));
    const total = state.buckets.reduce((sum, bucket) => sum + bucket.credits, 0);
    assert.strictEqual(total, entries, "merging branches must not lose credits");
  });

  test("drops the smallest projects once branches cannot absorb the cap", () => {
    let state = emptyAttribution(RESET);
    // Every project distinct, so there are no branches left to merge.
    for (let i = 0; i < MAX_ATTRIBUTION_BUCKETS + 20; i++) {
      state = attributeCredits(
        state,
        i + 1,
        context({ project: `project-${i}`, branch: "" }),
        "2026-09-15"
      );
    }

    assert.strictEqual(state.buckets.length, MAX_ATTRIBUTION_BUCKETS);
    // The largest survive; dropped credits fall back into the derived
    // unattributed remainder rather than being attributed to the wrong place.
    const smallest = Math.min(...state.buckets.map((bucket) => bucket.credits));
    assert.ok(smallest > 1, "the smallest projects should be the ones dropped");
  });
});

suite("summarizeAttribution", () => {
  test("returns null with nothing recorded", () => {
    assert.strictEqual(summarizeAttribution(undefined, 100), null);
    assert.strictEqual(summarizeAttribution(emptyAttribution(RESET), 100), null);
  });

  test("ranks projects by credits and computes shares of the period total", () => {
    const state = build([
      { credits: 30, context: { project: "api" } },
      { credits: 70, context: { project: "web" } },
    ]);

    const breakdown = summarizeAttribution(state, 200);

    assert.ok(breakdown);
    assert.deepStrictEqual(breakdown.projects.map((p) => p.project), ["web", "api"]);
    assert.strictEqual(breakdown.projects[0].share, 35);
    assert.strictEqual(breakdown.attributed, 100);
    assert.strictEqual(breakdown.total, 200);
  });

  test("derives the unattributed remainder from the period total", () => {
    const state = build([{ credits: 60 }]);

    const breakdown = summarizeAttribution(state, 100);

    assert.strictEqual(breakdown?.unattributed, 40);
    assert.strictEqual(breakdown?.unattributedShare, 40);
  });

  test("never reports negative unattributed or shares above 100%", () => {
    // More attributed than the rollups recorded — possible with two windows
    // observing the same usage, or clock skew.
    const state = build([{ credits: 150 }]);

    const breakdown = summarizeAttribution(state, 100);

    assert.strictEqual(breakdown?.unattributed, 0);
    assert.strictEqual(breakdown?.total, 150);
    assert.strictEqual(breakdown?.projects[0].share, 100);
  });

  test("sums a project's branches and lists them largest first", () => {
    const state = build([
      { credits: 10, context: { branch: "main" } },
      { credits: 25, context: { branch: "feature/x" } },
    ]);

    const breakdown = summarizeAttribution(state, 35);

    assert.strictEqual(breakdown?.projects.length, 1);
    assert.strictEqual(breakdown?.projects[0].credits, 35);
    assert.deepStrictEqual(
      breakdown?.projects[0].branches.map((b) => b.branch),
      ["feature/x", "main"]
    );
  });

  test("merges projects beyond the cap into one total", () => {
    const state = build([
      { credits: 50, context: { project: "a" } },
      { credits: 40, context: { project: "b" } },
      { credits: 30, context: { project: "c" } },
      { credits: 20, context: { project: "d" } },
    ]);

    const breakdown = summarizeAttribution(state, 140, { maxProjects: 2 });

    assert.strictEqual(breakdown?.projects.length, 2);
    assert.strictEqual(breakdown?.otherProjects, 50);
    assert.strictEqual(breakdown?.projectCount, 4);
  });

  test("caps the branches listed per project", () => {
    const state = build([
      { credits: 10, context: { branch: "a" } },
      { credits: 9, context: { branch: "b" } },
      { credits: 8, context: { branch: "c" } },
      { credits: 7, context: { branch: "d" } },
    ]);

    const breakdown = summarizeAttribution(state, 34, { maxBranches: 2 });

    assert.strictEqual(breakdown?.projects[0].branches.length, 2);
  });

  test("omits branches that were never tracked", () => {
    const state = build([{ credits: 10, context: { branch: "" } }]);

    const breakdown = summarizeAttribution(state, 10);

    assert.deepStrictEqual(breakdown?.projects[0].branches, []);
  });
});

suite("archiveAttribution", () => {
  test("collapses branches into project totals", () => {
    const state = build([
      { credits: 10, context: { branch: "main" } },
      { credits: 15, context: { branch: "feature/x" } },
      { credits: 5, context: { project: "web", branch: "main" } },
    ]);

    const archived = archiveAttribution(state);

    assert.strictEqual(archived?.length, 2);
    assert.deepStrictEqual(
      archived?.map((bucket) => [bucket.project, bucket.credits]),
      [["api", 25], ["web", 5]]
    );
    assert.ok(archived?.every((bucket) => bucket.branch === ""));
  });

  test("keeps only the largest projects", () => {
    const entries = Array.from({ length: MAX_ARCHIVED_ATTRIBUTION + 5 }, (_, i) => ({
      credits: i + 1,
      context: { project: `p${i}` },
    }));

    const archived = archiveAttribution(build(entries));

    assert.strictEqual(archived?.length, MAX_ARCHIVED_ATTRIBUTION);
    // The largest project is first.
    assert.strictEqual(archived?.[0].project, `p${entries.length - 1}`);
  });

  test("returns undefined when nothing was attributed", () => {
    assert.strictEqual(archiveAttribution(undefined), undefined);
    assert.strictEqual(archiveAttribution(emptyAttribution(RESET)), undefined);
  });
});
