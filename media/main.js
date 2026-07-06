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

  // --- Chart.js rendering -------------------------------------------------
  // The extension posts a serializable chart model (points + ranges + ticks,
  // no colors). We resolve theme colors here so the canvas tracks the active
  // VS Code theme, then draw with Chart.js.
  let chartInstance = null;
  let lastChartModel = null;

  // Map a series role to its theme color variable (with a hardcoded fallback).
  const ROLE_VARS = {
    actual: ["--vscode-charts-blue", "#3794ff"],
    ideal: ["--vscode-descriptionForeground", "#a0a0a0"],
    trend: ["--vscode-charts-purple", "#b180d7"],
    today: ["--vscode-charts-orange", "#d18616"],
  };

  // Resolve a CSS variable to a concrete rgb(a) string. Canvas can't read CSS
  // variables, so we probe a throwaway element and read its computed color.
  function resolveColor(varName, fallback) {
    const probe = document.createElement("span");
    probe.style.color = "var(" + varName + ", " + fallback + ")";
    probe.style.display = "none";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color || fallback;
  }

  function withAlpha(color, alpha) {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) {
      return color;
    }
    const parts = match[1].split(",").map((s) => s.trim()).slice(0, 3);
    return "rgba(" + parts.join(", ") + ", " + alpha + ")";
  }

  function areaBackground(ctx, area, rgb) {
    if (!area) {
      return withAlpha(rgb, 0.15);
    }
    const gradient = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    gradient.addColorStop(0, withAlpha(rgb, 0.3));
    gradient.addColorStop(1, withAlpha(rgb, 0.02));
    return gradient;
  }

  function buildDatasets(model) {
    return model.series.map((series) => {
      const spec = ROLE_VARS[series.role] || ROLE_VARS.actual;
      const rgb = resolveColor(spec[0], spec[1]);
      const dash = series.dashed
        ? series.role === "ideal"
          ? [5, 4]
          : series.role === "today"
            ? [3, 2]
            : [6, 4]
        : [];
      const dataset = {
        label: series.label,
        data: series.points,
        borderColor: rgb,
        borderWidth: series.role === "trend" ? 2.5 : series.role === "actual" ? 2 : 1,
        borderDash: dash,
        pointRadius: series.showPoints ? 2.5 : 0,
        pointHoverRadius: series.showPoints ? 4.5 : 0,
        pointBackgroundColor: rgb,
        pointBorderColor: rgb,
        tension: 0,
        order: series.role === "actual" ? 0 : 1,
        _tooltip: series.tooltip,
      };
      if (series.fill) {
        dataset.fill = "start";
        dataset.backgroundColor = (c) => areaBackground(c.chart.ctx, c.chart.chartArea, rgb);
      } else {
        dataset.fill = false;
      }
      return dataset;
    });
  }

  function buildConfig(model) {
    const muted = resolveColor("--vscode-descriptionForeground", "#a0a0a0");
    const grid = withAlpha(resolveColor("--vscode-panel-border", "#80808066"), 0.5);
    const xTickMap = new Map(model.xTicks.map((tick) => [tick.value, tick.label]));
    const xTickValues = model.xTicks.map((tick) => tick.value);
    const yTickValues = model.yTicks.slice();

    return {
      type: "line",
      data: { datasets: buildDatasets(model) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { top: 6, right: 8, bottom: 0, left: 0 } },
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: {
            type: "linear",
            min: model.xMin,
            max: model.xMax,
            border: { display: false },
            grid: { display: false },
            afterBuildTicks: (axis) => {
              axis.ticks = xTickValues.map((value) => ({ value }));
            },
            ticks: {
              color: muted,
              font: { size: 9 },
              autoSkip: false,
              maxRotation: 0,
              callback: (value) => (xTickMap.has(value) ? xTickMap.get(value) : ""),
            },
          },
          y: {
            type: "linear",
            min: model.yMin,
            max: model.yMax,
            border: { display: false },
            grid: { color: grid, drawTicks: false },
            afterBuildTicks: (axis) => {
              axis.ticks = yTickValues.map((value) => ({ value }));
            },
            ticks: {
              color: muted,
              font: { size: 9 },
              autoSkip: false,
              callback: (value) => Math.round(value),
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            filter: (item) => item.dataset._tooltip === true,
            callbacks: {
              title: (items) => {
                if (!items.length) {
                  return "";
                }
                return new Date(items[0].parsed.x).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
              },
              label: (item) => item.dataset.label + ": " + Math.round(item.parsed.y) + " " + model.unit,
            },
          },
        },
      },
    };
  }

  function renderChart(model) {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    const canvas = document.getElementById("insightsChart");
    if (!model || !canvas || typeof Chart === "undefined") {
      return;
    }
    chartInstance = new Chart(canvas, buildConfig(model));
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
        lastChartModel = model.chart || null;
        showState("data");
        // Draw after showState so the canvas has layout to size against.
        renderChart(lastChartModel);
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

  // Re-render the chart when the color theme changes so canvas colors, which
  // are resolved from CSS variables at draw time, track the active theme.
  new MutationObserver(() => {
    if (lastChartModel) {
      renderChart(lastChartModel);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // Restore the last known model instantly (e.g. after the view was hidden),
  // then ask the extension for fresh data.
  applyModel(vscode.getState());
  vscode.postMessage({ command: "ready" });
})();
