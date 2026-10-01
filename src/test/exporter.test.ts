import * as assert from "assert";
import { serializeAttribution, serializeHistory } from "../core/exporter";
import { AttributionState, LocalSnapshot } from "../types";
import { resolveWorkspaceContext } from "../ui/workspaceContext";

function makeSnapshot(overrides: Partial<LocalSnapshot> = {}): LocalSnapshot {
  return {
    timestamp: "2026-07-01T00:00:00.000Z",
    premium_remaining: 120,
    premium_entitlement: 300,
    ...overrides,
  };
}

suite("serializeHistory", () => {
  test("serializes history as pretty-printed JSON", () => {
    const history = [makeSnapshot()];
    const json = serializeHistory(history, "json");
    assert.deepStrictEqual(JSON.parse(json), history);
    assert.ok(json.includes("\n"), "JSON output should be pretty-printed");
  });

  test("serializes empty history as empty JSON array", () => {
    assert.deepStrictEqual(JSON.parse(serializeHistory([], "json")), []);
  });

  test("serializes history as CSV with header row", () => {
    const history = [
      makeSnapshot(),
      makeSnapshot({ timestamp: "2026-07-02T00:00:00.000Z", premium_remaining: 90 }),
    ];
    assert.strictEqual(
      serializeHistory(history, "csv"),
      [
        "timestamp,premium_remaining,premium_entitlement",
        "2026-07-01T00:00:00.000Z,120,300",
        "2026-07-02T00:00:00.000Z,90,300",
      ].join("\n")
    );
  });

  test("serializes empty history as CSV header only", () => {
    assert.strictEqual(
      serializeHistory([], "csv"),
      "timestamp,premium_remaining,premium_entitlement"
    );
  });
});

suite("serializeAttribution", () => {
  const state: AttributionState = {
    resetDate: "2026-10-01T00:00:00Z",
    buckets: [
      { project: "api", branch: "main", credits: 20, lastDate: "2026-09-14" },
      { project: "web", branch: "feature/x", credits: 45, lastDate: "2026-09-15" },
    ],
  };

  test("serializes as CSV, largest first", () => {
    assert.strictEqual(
      serializeAttribution(state, "csv"),
      [
        "project,branch,credits,last_date",
        "web,feature/x,45,2026-09-15",
        "api,main,20,2026-09-14",
      ].join("\n")
    );
  });

  test("quotes fields containing a comma", () => {
    const csv = serializeAttribution(
      {
        resetDate: "",
        buckets: [
          { project: "my, project", branch: "main", credits: 5, lastDate: "2026-09-15" },
        ],
      },
      "csv"
    );

    assert.ok(csv.includes('"my, project"'), `expected a quoted field in: ${csv}`);
  });

  test("serializes as JSON with the period it belongs to", () => {
    const parsed = JSON.parse(serializeAttribution(state, "json"));

    assert.strictEqual(parsed.resetDate, "2026-10-01T00:00:00Z");
    assert.strictEqual(parsed.buckets.length, 2);
    assert.strictEqual(parsed.buckets[0].project, "web");
  });

  test("handles no attribution at all", () => {
    assert.strictEqual(
      serializeAttribution(undefined, "csv"),
      "project,branch,credits,last_date"
    );
    assert.deepStrictEqual(JSON.parse(serializeAttribution(undefined, "json")), {
      resetDate: "",
      buckets: [],
    });
  });
});

suite("resolveWorkspaceContext", () => {
  test("records nothing when attribution is off", () => {
    assert.deepStrictEqual(resolveWorkspaceContext("off"), { project: "", branch: "" });
  });

  test("omits the branch in project-only mode", () => {
    assert.strictEqual(resolveWorkspaceContext("project").branch, "");
  });

  test("returns strings for the running window without throwing", () => {
    // The test host may or may not have a folder open; either is valid, and
    // the Git extension may be absent entirely.
    const context = resolveWorkspaceContext("project-and-branch");

    assert.strictEqual(typeof context.project, "string");
    assert.strictEqual(typeof context.branch, "string");
  });
});
