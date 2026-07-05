import * as assert from "assert";
import {
  escapeHtml,
  formatQuotaName,
  formatQuotaValue,
} from "../core/format";

suite("escapeHtml", () => {
  test("escapes HTML special characters", () => {
    assert.strictEqual(
      escapeHtml(`<img src=x onerror="alert('xss')">&`),
      "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;"
    );
  });

  test("handles null and undefined", () => {
    assert.strictEqual(escapeHtml(null), "");
    assert.strictEqual(escapeHtml(undefined), "");
  });

  test("passes through safe strings", () => {
    assert.strictEqual(escapeHtml("octocat"), "octocat");
  });
});

suite("formatQuotaName", () => {
  test("maps known quota ids", () => {
    assert.strictEqual(formatQuotaName("premium_interactions"), "AI Credits");
    assert.strictEqual(formatQuotaName("completions"), "Suggestions");
  });

  test("title-cases unknown quota ids", () => {
    assert.strictEqual(formatQuotaName("some_new_quota"), "Some New Quota");
  });
});

suite("formatQuotaValue", () => {
  test("trims to two decimals and drops trailing zeros", () => {
    assert.strictEqual(formatQuotaValue(120), "120");
    assert.strictEqual(formatQuotaValue(120.5), "120.5");
    assert.strictEqual(formatQuotaValue(120.456), "120.46");
    assert.strictEqual(formatQuotaValue(120.1), "120.1");
  });
});
