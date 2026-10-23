(function () {
  const vscode = acquireVsCodeApi();
  const labels = JSON.parse(document.getElementById("labels").textContent);
  const tr = (label) => labels[label] || label;
  const element = (id) => document.getElementById(id);
  const restored = vscode.getState();
  const state = restored && restored.version === 1 ? restored : { version: 1 };
  let catalog;
  let requestId = 0;
  const number = (value) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(value);
  const controls = ["search", "provider", "access", "tier", "sort", "units", "estimate-model", "mode", "input", "cached", "write", "output"];
  const persist = () => {
    if (!catalog) { vscode.setState(state); return; }
    for (const id of controls) { state[id] = element(id).value; }
    vscode.setState(state);
  };
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    if (className) { result.className = className; }
    return result;
  };
  const expired = (model) => model.validUntil && Date.now() >= Date.parse(model.validUntil) + 86400000;
  const sourceButton = (key, label) => {
    const button = node("button", label, "source-link");
    button.addEventListener("click", () => vscode.postMessage({ command: "openSource", key }));
    return button;
  };
  function options(id, values, first) {
    const select = element(id);
    const previous = select.value || state[id];
    select.replaceChildren();
    for (const [value, label] of (first ? [["", tr(first)], ...values] : values)) {
      const option = node("option", label);
      option.value = value;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previous)) { select.value = previous; }
  }
  function table(headers, rows) {
    const result = node("table");
    const head = node("thead");
    const header = node("tr");
    for (const label of headers) {
      const cell = node("th", label);
      cell.scope = "col";
      header.appendChild(cell);
    }
    head.appendChild(header);
    result.appendChild(head);
    const body = node("tbody");
    for (const row of rows) {
      const line = node("tr");
      row.forEach((value, index) => {
        const cell = node(index === 0 ? "th" : "td", value);
        if (index === 0) { cell.scope = "row"; }
        line.appendChild(cell);
      });
      body.appendChild(line);
    }
    result.appendChild(body);
    const wrapper = node("div", undefined, "table-scroll");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", headers[0]);
    wrapper.appendChild(result);
    return wrapper;
  }
  function showTab(index, focus = false) {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) { index = 0; }
    tabs.forEach((tab, current) => {
      tab.setAttribute("aria-selected", String(current === index));
      tab.tabIndex = current === index ? 0 : -1;
      element("panel-" + current).hidden = current !== index;
    });
    if (focus) { tabs[index].focus(); }
    state.tab = index;
    persist();
  }
  function selectedModel() {
    return catalog.models.find(model => model.id === element("estimate-model").value) || catalog.models[0];
  }
  function renderDetails() {
    const model = selectedModel();
    element("model-name").textContent = model.name;
    const target = element("model-details");
    target.replaceChildren();
    const details = node("dl");
    for (const [label, value] of [["Provider", model.provider], ["Access", catalog.access[model.access]],
      ["Context threshold", model.threshold ? number(model.threshold) : tr("No separate long-context tier published")]]) {
      details.append(node("dt", tr(label)), node("dd", value));
    }
    target.appendChild(details);
    if (model.note) { target.appendChild(node("p", catalog.notes[model.note], "muted")); }
    if (model.validUntil) {
      target.appendChild(node("p", expired(model) ? tr("Promotional rates expired") : tr("Promotion valid through") + " " + model.validUntil, expired(model) ? "warning" : "muted"));
    }
    if (model.access === "annual") { target.appendChild(node("p", tr("Legacy annual request billing is not a token-cost estimate."), "warning")); }
    target.append(node("p", tr("Availability depends on your plan, client, and organization policies."), "muted"), sourceButton("models", tr("Model access")), sourceButton("pricing", tr("Source")));
  }
  function renderModels() {
    const query = element("search").value.trim().toLowerCase();
    const provider = element("provider").value;
    const access = element("access").value;
    const long = element("tier").value === "long";
    const sort = element("sort").value;
    const factor = element("units").value === "credits" ? 1 / catalog.creditCostUsd : 1;
    const rate = (model) => long ? model.longContext : model.rates;
    const models = catalog.models.filter(model => (!query || (model.name + " " + model.provider).toLowerCase().includes(query)) &&
      (!provider || model.provider === provider) && (!access || model.access === access) && (!long || model.longContext));
    models.sort((left, right) => sort === "name" ? left.name.localeCompare(right.name) : rate(left)[sort] - rate(right)[sort] || left.name.localeCompare(right.name));
    element("count").textContent = models.length ? number(models.length) + " / " + number(catalog.models.length) : tr("No models match these filters.");
    const content = table([tr("Model"), tr("Input"), tr("Cached input"), tr("Cache write"), tr("Output")], []);
    const tableElement = content.querySelector("table");
    const body = tableElement.querySelector("tbody");
    for (const model of models) {
      const row = node("tr");
      const selected = model.id === selectedModel().id;
      row.classList.toggle("selected", selected);
      const name = node("th");
      name.scope = "row";
      const button = node("button", model.name, "model-button");
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        element("estimate-model").value = model.id;
        renderDetails();
        renderModels();
        const replacement = [...element("models").querySelectorAll("button")].find(item => item.textContent === model.name);
        replacement?.focus({ preventScroll: true });
        calculate();
        persist();
      });
      name.append(button, node("small", model.provider));
      if (expired(model)) { name.appendChild(node("small", tr("Rate expired; check source."), "warning")); }
      row.appendChild(name);
      for (const key of ["input", "cached", "write", "output"]) {
        const value = rate(model)[key];
        const cell = node("td", value === null ? "N/A" : number(value * factor), "numeric");
        if (value === null) { cell.title = tr("No separate rate published"); }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    element("models").replaceChildren(...tableElement.childNodes);
  }
  function calculate() {
    const current = ++requestId;
    const inputs = ["input", "cached", "write", "output"];
    const invalid = inputs.some(id => !element(id).validity.valid);
    for (const id of inputs) { element(id).setAttribute("aria-invalid", String(!element(id).validity.valid)); }
    element("estimate-result").replaceChildren();
    element("estimate-error").hidden = !invalid;
    if (invalid) { element("estimate-error").textContent = tr("Enter valid nonnegative whole token counts."); return; }
    const tokens = Object.fromEntries(inputs.map(id => [id, Number(element(id).value)]));
    tokens.mode = element("mode").value;
    vscode.postMessage({ command: "estimate", requestId: current, model: selectedModel().id, tokens });
  }
  function renderReference() {
    element("plans").replaceChildren(table([tr("Plans"), tr("Monthly USD"), tr("Base credits"), tr("Flex credits"), tr("Included credits"), tr("Ownership"), tr("Model access"), tr("Management"), tr("Additional usage"), tr("Training")],
      catalog.plans.map(plan => [plan.name, "$" + number(plan.monthly) + (plan.audience === "Organization" ? " / " + tr("Per seat") : ""), number(plan.base), plan.flex === null ? tr("Not applicable") : number(plan.flex), number(plan.base + (plan.flex || 0)), plan.ownership, plan.models, plan.management, plan.extra, plan.training])));
    const guidance = element("guidance");
    guidance.replaceChildren(table([tr("Task"), ...catalog.groups.map(group => group.name)], catalog.guidance.map(row => [row.task, ...row.fits])));
    guidance.appendChild(table([tr("Guidance"), tr("Suggested models")], catalog.groups.map(group => [group.name, group.examples])));
    guidance.append(node("h2", tr("Routing")), table([tr("Routing"), tr("Behavior"), tr("Suggested use")], catalog.selectionOptions.map(option => [option.name, option.behavior, option.use])));
    guidance.append(node("h2", tr("Auto tiers")), table([tr("Tier"), tr("Priority"), tr("Suggested use")], catalog.autoTiers.map(tier => [tier.name, tier.priority, tier.use])));
    guidance.append(node("h2", tr("HydraFusion patterns")), table([tr("Model"), tr("Behavior")], catalog.hydraPatterns.map(pattern => [pattern.name, pattern.behavior])), node("p", tr("HydraFusion is a research preview. Each participating model is billed at standard rates; no Auto discount applies."), "muted"));
    const sources = node("ul");
    for (const [key, source] of Object.entries(catalog.sources)) {
      const item = node("li");
      item.appendChild(sourceButton(key, source.title));
      sources.appendChild(item);
    }
    element("sources").replaceChildren(sources);
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "catalog") {
      catalog = message.catalog;
      const origins = { bundled: "Bundled snapshot", cached: "Cached snapshot", updated: "Updated snapshot" };
      element("metadata").textContent = tr("Reviewed") + " " + catalog.reviewedAt + " | " + tr(origins[message.origin]) + " | " + catalog.revision + " | " + tr("Billing rules reviewed") + " " + catalog.billingRules.reviewedAt;
      element("stale").hidden = !message.stale;
      options("provider", [...new Set(catalog.models.map(model => model.provider))].sort().map(provider => [provider, provider]), "All providers");
      options("access", Object.entries(catalog.access), "All access categories");
      options("estimate-model", catalog.models.map(model => [model.id, model.name]));
      renderModels();
      renderDetails();
      renderReference();
      element("content").hidden = false;
      calculate();
      persist();
    }
    if (message.type === "estimate" && message.requestId === requestId) {
      element("estimate-error").hidden = !message.error;
      element("estimate-error").textContent = message.error || "";
      const output = element("estimate-result");
      output.replaceChildren();
      if (message.result) {
        const result = message.result;
        output.append(node("div", number(result.credits) + " " + tr("AI credits"), "estimate-total"), node("p", "$" + number(result.usd) + " USD"));
        output.appendChild(table([tr("Source"), tr("USD")], Object.entries(result.components).map(([key, value]) => [tr({ input: "Input", cached: "Cached input", write: "Cache write", output: "Output" }[key]), "$" + number(value)])));
        output.append(node("p", tr("Applied tier") + ": " + tr(result.tier === "long" ? "Long context" : "Default")), node("p", tr("Discount") + ": " + number(result.discount * 100) + "%"));
      }
    }
    const statuses = { refreshing: "Refreshing catalog...", refreshed: "Catalog updated.", refreshError: "Could not refresh the catalog. Keeping the current snapshot.", loadError: "Catalog unavailable." };
    if (statuses[message.type]) {
      element("status").textContent = tr(statuses[message.type]);
      element("refresh").disabled = message.type === "refreshing";
      element("content").setAttribute("aria-busy", String(message.type === "refreshing"));
    }
  });
  for (const id of controls) {
    if (state[id] !== undefined && !["provider", "access", "estimate-model"].includes(id)) { element(id).value = state[id]; }
  }
  for (const [id, value] of [["input", 100000], ["cached", 0], ["write", 0], ["output", 10000]]) {
    if (state[id] === undefined) { element(id).value = value; }
  }
  element("units").value ||= "credits";
  controls.forEach(id => element(id).addEventListener(id === "search" || ["input", "cached", "write", "output"].includes(id) ? "input" : "change", () => {
    if (!catalog) { return; }
    renderModels();
    renderDetails();
    calculate();
    persist();
  }));
  document.querySelectorAll('[role="tab"]').forEach((tab, index) => {
    tab.addEventListener("click", () => showTab(index));
    tab.addEventListener("keydown", event => {
      const keys = { ArrowRight: (index + 1) % 5, ArrowLeft: (index + 4) % 5, Home: 0, End: 4 };
      if (Object.hasOwn(keys, event.key)) { event.preventDefault(); showTab(keys[event.key], true); }
    });
  });
  element("estimate-form").addEventListener("submit", event => event.preventDefault());
  element("estimate-selected").addEventListener("click", () => { showTab(1); element("input").focus(); });
  element("refresh").addEventListener("click", () => vscode.postMessage({ command: "refresh" }));
  element("guide").addEventListener("click", () => vscode.postMessage({ command: "openGuide" }));
  showTab(state.tab || 0);
  vscode.postMessage({ command: "ready" });
})();