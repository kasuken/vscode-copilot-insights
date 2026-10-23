import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { runInNewContext } from "vm";

// Minimal DOM double for the real client message handler. Replacing innerHTML
// detaches focused summaries, just as a browser does.
function client() {
  let activeElement: Element | undefined;
  let hasFocus = true;
  let update!: (event: unknown) => void;
  const elements = new Map<string, Element>();
  class Element {
    open = false;
    summary?: Element;
    details: Element[] = [];
    classList = { toggle() {} };
    focusOptions?: FocusOptions;
    constructor(readonly id: string) {}
    addEventListener() {}
    focus(options?: FocusOptions) { activeElement = this; this.focusOptions = options; }
    querySelector() { return this.summary; }
    querySelectorAll() {
      return this.id === "state-data"
        ? [...elements.values()].filter(el => el.id.startsWith("section-")).flatMap(el => el.details)
        : this.details;
    }
    set innerHTML(html: string) {
      if (this.details.some(details => details.summary === activeElement)) { activeElement = undefined; }
      this.details = [...html.matchAll(/<details[^>]*id="([^"]+)"[^>]*>/g)].map(match => {
        const details = new Element(match[1]);
        details.open = /\bopen\b/.test(match[0]);
        details.summary = new Element(match[1] + "-summary");
        return details;
      });
    }
  }
  for (const id of ["state-loading", "state-signin", "state-error", "state-data", "error-message",
    "last-updated", "signInButton", "copyButton", "copyJsonButton", "modelCostsButton",
    "section-confidence", "section-timeline", "section-budget"]) {
    elements.set(id, new Element(id));
  }
  runInNewContext(readFileSync(path.resolve(__dirname, "../../media/main.js"), "utf8"), {
    acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage() {} }),
    document: {
      getElementById: (id: string) => elements.get(id),
      get activeElement() { return activeElement; },
      hasFocus: () => hasFocus,
    },
    window: { addEventListener: (_: string, listener: typeof update) => { update = listener; } },
    MutationObserver: class { observe() {} },
  });
  const send = (model: unknown) => update({ data: { type: "update", model } });
  return {
    send,
    refresh(overrides = {}, account = "alice") {
      send({
        state: "data", account,
        sections: Object.fromEntries(["confidence", "timeline", "budget"].map(id => [
          id, `<details class="observation-details" id="${id}-details"><summary>Updated explanation</summary></details>`,
        ]).concat(Object.entries(overrides))),
      });
    },
    details: (section: string) => elements.get("section-" + section)!.details[0],
    button: elements.get("copyButton")!,
    get activeElement() { return activeElement; },
    blurWindow() { hasFocus = false; },
  };
}

suite("Webview disclosure refresh", () => {
  test("preserves independent open/closed states and focused summary without scrolling", () => {
    const view = client();
    view.refresh();
    view.details("confidence").open = true;
    view.details("budget").open = true;
    const oldSummary = view.details("timeline").summary!;
    oldSummary.focus(); // A closed disclosure can also have keyboard focus.
    view.refresh();
    assert.strictEqual(view.details("confidence").open, true);
    assert.strictEqual(view.details("budget").open, true);
    assert.strictEqual(view.details("timeline").open, false);
    assert.notStrictEqual(view.activeElement, oldSummary);
    assert.strictEqual(view.activeElement, view.details("timeline").summary);
    assert.strictEqual(view.activeElement!.focusOptions!.preventScroll, true);
    view.details("budget").open = false;
    view.refresh();
    assert.strictEqual(view.details("budget").open, false);
  });

  test("does not steal focus from another control or an unfocused webview", () => {
    const view = client();
    view.refresh();
    view.details("budget").open = true;
    view.button.focus();
    view.refresh();
    assert.strictEqual(view.activeElement, view.button);
    view.details("budget").summary!.focus();
    view.blurWindow();
    view.refresh();
    assert.strictEqual(view.activeElement, undefined);
    assert.strictEqual(view.details("budget").open, true);
    assert.strictEqual(view.details("budget").summary!.focusOptions, undefined);
  });

  test("removed disclosures lose state and focus, including when they reappear", () => {
    const view = client();
    view.refresh();
    view.details("timeline").open = true;
    view.details("timeline").summary!.focus();
    view.refresh({ timeline: "" });
    assert.strictEqual(view.details("timeline"), undefined);
    assert.strictEqual(view.activeElement, undefined);
    view.refresh();
    assert.strictEqual(view.details("timeline").open, false);
    assert.strictEqual(view.activeElement, undefined);
  });

  test("does not restore stale state across sign-in, loading, errors or account changes", () => {
    for (const state of ["signin", "loading", "error", "account"]) {
      const view = client();
      view.refresh();
      view.details("confidence").open = true;
      view.details("confidence").summary!.focus();
      if (state !== "account") { view.send({ state }); }
      view.refresh({}, state === "account" ? "bob" : "alice");
      assert.strictEqual(view.details("confidence").open, false, state);
      assert.strictEqual(view.activeElement, undefined, state);
    }
  });
});
