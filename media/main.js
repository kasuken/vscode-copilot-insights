// Client script for the Copilot Insights webview.
// The extension posts state messages ({ type: 'update', model }) and this
// script renders them into the static shell. Because the shell HTML is never
// replaced, refreshes preserve the scroll position.
(function () {
  const vscode = acquireVsCodeApi();

  const stateElements = {
    loading: document.getElementById("state-loading"),
    signin: document.getElementById("state-signin"),
    error: document.getElementById("state-error"),
    data: document.getElementById("state-data"),
  };

  function showState(name) {
    for (const [key, el] of Object.entries(stateElements)) {
      el.classList.toggle("hidden", key !== name);
    }
  }

  function applyModel(model) {
    if (!model || !model.state) {
      return;
    }

    switch (model.state) {
      case "loading":
        showState("loading");
        return;
      case "signin":
        showState("signin");
        return;
      case "error":
        document.getElementById("error-message").textContent = model.message || "Unknown error";
        showState("error");
        return;
      case "data": {
        for (const [id, html] of Object.entries(model.sections || {})) {
          const el = document.getElementById("section-" + id);
          if (el) {
            el.innerHTML = html;
          }
        }
        document.getElementById("last-updated").textContent = model.lastFetched || "";
        showState("data");
        return;
      }
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "update") {
      vscode.setState(message.model);
      applyModel(message.model);
    }
  });

  document.getElementById("signInButton").addEventListener("click", () => {
    vscode.postMessage({ command: "signIn" });
  });
  document.getElementById("copyButton").addEventListener("click", () => {
    vscode.postMessage({ command: "copyToClipboard" });
  });
  document.getElementById("copyJsonButton").addEventListener("click", () => {
    vscode.postMessage({ command: "copyJsonToClipboard" });
  });

  // Restore the last known model instantly (e.g. after the view was hidden),
  // then ask the extension for fresh data.
  applyModel(vscode.getState());
  vscode.postMessage({ command: "ready" });
})();
