import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension", () => {
  test("activates", async () => {
    const extension = vscode.extensions.getExtension(
      "emanuelebartolesi.vscode-copilot-insights"
    );
    assert.ok(extension, "extension not found");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "vscode-copilot-insights.refresh",
      "vscode-copilot-insights.openSettings",
      "vscode-copilot-insights.resetToDefaults",
    ]) {
      assert.ok(commands.includes(id), `missing command: ${id}`);
    }
  });
});
