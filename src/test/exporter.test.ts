import * as assert from "assert";
import { serializeHistory } from "../core/exporter";
import { LocalSnapshot } from "../types";

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
