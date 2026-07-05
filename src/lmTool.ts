import * as vscode from "vscode";
import { generateMarkdownSummary } from "./core/markdown";
import { CopilotInsightsViewProvider } from "./ui/webview/provider";

/**
 * Language model tool that lets Copilot Chat answer questions like
 * "how many AI credits do I have left?" using the user's live quota data.
 */
export class CopilotQuotaTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly _provider: CopilotInsightsViewProvider) { }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const data = await this._provider.getOrFetchData();

    if (!data) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Copilot quota data is unavailable. The user may need to sign in to GitHub in VS Code (open the Copilot Insights view to sign in)."
        ),
      ]);
    }

    const customLimit = vscode.workspace
      .getConfiguration("copilotInsights")
      .get<number>("customCreditLimit", 0);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        generateMarkdownSummary(data, customLimit, vscode.env.language)
      ),
    ]);
  }

  prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: "Reading Copilot quota data",
    };
  }
}
