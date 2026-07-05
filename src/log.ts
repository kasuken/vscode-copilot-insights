import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** Returns the shared "Copilot Insights" log output channel, creating it on first use. */
export function getLog(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Copilot Insights", { log: true });
  }
  return channel;
}
