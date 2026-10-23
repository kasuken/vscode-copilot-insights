import * as vscode from "vscode";
import { CatalogSnapshot, ModelCatalogStore } from "../../api/modelCatalogApi";
import { estimateModelCost, isCatalogSourceUrl, isCatalogStale, TokenEstimateInput } from "../../core/modelCatalog";
import { escapeHtml, getNonce } from "../../core/format";

const labels = [
  "Model Costs", "Catalog", "Estimator", "Plans", "Guidance", "Sources", "Open guide", "Refresh catalog",
  "Search models", "Provider", "Access", "All providers", "All access categories", "Tier", "Default", "Long context",
  "Sort by", "Model name", "Input rate", "Output rate", "Units", "USD", "AI credits", "Model", "Input", "Cached input",
  "Cache write", "Output", "Selected model", "Estimate cost", "Billing scenario", "Standard rates", "Auto (eligible paid plan)",
  "Auto (Max plan)", "Total input tokens", "Cached input tokens", "Cache-write tokens", "Output tokens", "Estimated cost",
  "Cached reads and cache writes are subsets of total input, not additional input tokens.",
  "Estimate only. Actual sessions can include multiple model calls and additional context. Auto may select a different model.",
  "No separate rate published", "No models match these filters.", "Reviewed", "Billing rules reviewed", "Bundled snapshot", "Cached snapshot",
  "Updated snapshot", "Refreshing catalog...", "Catalog updated.", "Could not refresh the catalog. Keeping the current snapshot.",
  "Reference data is over 30 days old. Check current official rates before budgeting.", "Promotional rates expired", "Promotion valid through",
  "Rates per 1 million tokens", "Availability depends on your plan, client, and organization policies.", "Context threshold",
  "Default rates apply at or below the threshold; long-context rates apply above it.", "No separate long-context tier published",
  "Legacy annual request billing is not a token-cost estimate.", "Monthly USD", "Base credits", "Flex credits", "Included credits",
  "Ownership", "Model access", "Management", "Additional usage", "Training", "Not applicable", "Per seat", "Plan reference only. Your account-reported allowance remains authoritative. Free, Student, and legacy annual plans have different rules.",
  "Editorial starting points, not benchmarks or an official ranking.", "Task", "Suggested models", "Routing", "Behavior", "Suggested use",
  "Auto tiers", "Priority", "HydraFusion patterns", "HydraFusion is a research preview. Each participating model is billed at standard rates; no Auto discount applies.",
  "Source", "Discount", "Applied tier", "Enter valid nonnegative whole token counts.", "Catalog unavailable.", "Rate expired; check source.",
];

export function renderModelCostsShell(webview: vscode.Webview, extensionUri: vscode.Uri, localize: (value: string) => string = vscode.l10n.t): string {
  const nonce = getNonce();
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
  const translate = (value: string) => escapeHtml(localize(value));
  const option = (value: string, label: string) => `<option value="${value}">${translate(label)}</option>`;
  const field = (id: string, label: string) => `<label for="${id}">${translate(label)}<input id="${id}" type="number" min="0" max="1000000000000" step="1" required aria-describedby="token-note estimate-error"></label>`;
  const strings = JSON.stringify(Object.fromEntries(labels.map(label => [label, localize(label)]))).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="${escapeHtml(vscode.env.language)}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("codicons/codicon.css")}"><link rel="stylesheet" href="${asset("model-costs.css")}">
<title>${translate("Model Costs")}</title></head><body>
<header><h1>${translate("Model Costs")}</h1><div class="tools">
<button id="guide" title="${translate("Open guide")}" aria-label="${translate("Open guide")}"><i class="codicon codicon-link-external" aria-hidden="true"></i></button>
<button id="refresh" title="${translate("Refresh catalog")}" aria-label="${translate("Refresh catalog")}"><i class="codicon codicon-refresh" aria-hidden="true"></i></button></div></header>
<p id="metadata" class="muted"></p><p id="status" role="status"></p><p id="stale" class="warning" hidden>${translate("Reference data is over 30 days old. Check current official rates before budgeting.")}</p>
<nav role="tablist" aria-label="${translate("Model Costs")}">${["Catalog", "Estimator", "Plans", "Guidance", "Sources"].map((label, index) => `<button role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${translate(label)}</button>`).join("")}</nav>
<main id="content" hidden>
<section role="tabpanel" id="panel-0" aria-labelledby="tab-0">
<div class="filters"><label for="search">${translate("Search models")}<input id="search" type="search"></label>
<label for="provider">${translate("Provider")}<select id="provider"></select></label>
<label for="access">${translate("Access")}<select id="access"></select></label>
<label for="tier">${translate("Tier")}<select id="tier">${option("default", "Default")}${option("long", "Long context")}</select></label>
<label for="sort">${translate("Sort by")}<select id="sort">${option("name", "Model name")}${option("input", "Input rate")}${option("output", "Output rate")}</select></label>
<label for="units">${translate("Units")}<select id="units">${option("credits", "AI credits")}${option("usd", "USD")}</select></label></div>
<p class="muted">${translate("Rates per 1 million tokens")}</p><p id="count" role="status"></p>
<div class="catalog-layout"><div class="table-scroll" tabindex="0" role="region" aria-label="${translate("Catalog")}"><table id="models"></table></div>
<aside aria-label="${translate("Selected model")}"><h2 id="model-name"></h2><div id="model-details"></div><button id="estimate-selected">${translate("Estimate cost")}</button></aside></div>
</section>
<section role="tabpanel" id="panel-1" aria-labelledby="tab-1" hidden><div class="estimate-layout"><form id="estimate-form">
<label for="estimate-model">${translate("Model")}<select id="estimate-model"></select></label>
<label for="mode">${translate("Billing scenario")}<select id="mode">${option("standard", "Standard rates")}${option("auto", "Auto (eligible paid plan)")}${option("max-auto", "Auto (Max plan)")}</select></label>
${field("input", "Total input tokens")}${field("cached", "Cached input tokens")}${field("write", "Cache-write tokens")}${field("output", "Output tokens")}
<p id="token-note" class="muted">${translate("Cached reads and cache writes are subsets of total input, not additional input tokens.")}</p></form>
<div><h2>${translate("Estimated cost")}</h2><p id="estimate-error" class="warning" role="status" hidden></p><output id="estimate-result" aria-live="polite"></output>
<p class="muted">${translate("Estimate only. Actual sessions can include multiple model calls and additional context. Auto may select a different model.")}</p></div></div></section>
<section role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden><p class="muted">${translate("Plan reference only. Your account-reported allowance remains authoritative. Free, Student, and legacy annual plans have different rules.")}</p><div id="plans"></div></section>
<section role="tabpanel" id="panel-3" aria-labelledby="tab-3" hidden><p class="muted">${translate("Editorial starting points, not benchmarks or an official ranking.")}</p><div id="guidance"></div></section>
<section role="tabpanel" id="panel-4" aria-labelledby="tab-4" hidden><div id="sources"></div></section>
</main><script nonce="${nonce}" type="application/json" id="labels">${strings}</script><script nonce="${nonce}" src="${asset("model-costs.js")}"></script></body></html>`;
}

export function registerModelCosts(context: vscode.ExtensionContext): void {
  const store = new ModelCatalogStore(context);
  let panel: vscode.WebviewPanel | undefined;
  context.subscriptions.push(vscode.commands.registerCommand("vscode-copilot-insights.modelCosts", () => {
    if (panel) { panel.reveal(); return; }
    const currentPanel = vscode.window.createWebviewPanel("copilotInsights.modelCosts", vscode.l10n.t("Model Costs"), vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    panel = currentPanel;
    context.subscriptions.push(currentPanel);
    let snapshot: CatalogSnapshot | undefined;
    let loadFailed = false;
    let refreshing = false;
    const publish = () => {
      if (snapshot) { void currentPanel.webview.postMessage({ type: "catalog", ...snapshot, stale: isCatalogStale(snapshot.catalog) }); }
      else if (loadFailed) { void currentPanel.webview.postMessage({ type: "loadError" }); }
    };
    const subscription = currentPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object" || !("command" in message)) { return; }
      const data = message as Record<string, unknown>;
      if (data.command === "ready") { publish(); }
      if (data.command === "openGuide") {
        await vscode.env.openExternal(vscode.Uri.parse("https://www.emanuelebartolesi.com/resources/github-copilot"));
      }
      if (data.command === "openSource" && snapshot && typeof data.key === "string" && Object.hasOwn(snapshot.catalog.sources, data.key)) {
        const url = snapshot.catalog.sources[data.key].url;
        if (isCatalogSourceUrl(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
      }
      if (data.command === "refresh" && snapshot && !refreshing) {
        refreshing = true;
        void currentPanel.webview.postMessage({ type: "refreshing" });
        try {
          snapshot = await store.refresh(snapshot);
          publish();
          void currentPanel.webview.postMessage({ type: "refreshed" });
        } catch {
          void currentPanel.webview.postMessage({ type: "refreshError" });
        } finally { refreshing = false; }
      }
      if (data.command === "estimate" && snapshot && typeof data.model === "string" && Number.isSafeInteger(data.requestId)) {
        try {
          const model = snapshot.catalog.models.find(model => model.id === data.model);
          if (!model || !data.tokens || typeof data.tokens !== "object") { throw new Error("Invalid estimate"); }
          const result = estimateModelCost(snapshot.catalog, model, data.tokens as TokenEstimateInput);
          void currentPanel.webview.postMessage({ type: "estimate", requestId: data.requestId, result });
        } catch (error) {
          void currentPanel.webview.postMessage({ type: "estimate", requestId: data.requestId, error: vscode.l10n.t(error instanceof Error ? error.message : "Invalid estimate") });
        }
      }
    });
    currentPanel.onDidDispose(() => { subscription.dispose(); if (panel === currentPanel) { panel = undefined; } });
    currentPanel.webview.html = renderModelCostsShell(currentPanel.webview, context.extensionUri);
    void store.load().then(value => { snapshot = value; publish(); }, () => {
      loadFailed = true;
      publish();
    });
  }));
}