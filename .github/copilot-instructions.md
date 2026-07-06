---
applyTo: "**" 
description: "VS Code extension project guidelines for GitHub Copilot Insights. Covers project shape, code style, VS Code extension rules, build and test, and repository discipline."
name: "Project Guidelines"
---

# GitHub Copilot Insights

- This repository is a VS Code extension for showing GitHub Copilot plan, quota, reset, history, and AI credit usage insights inside VS Code.
- Keep extension-host logic in `src/`, with activation and command/view wiring in `src/extension.ts`, Copilot data access in `src/api/`, pure formatting/history/prediction/quota logic in `src/core/`, and UI-specific code in `src/ui/`.
- The extension is bundled to `dist/extension.js` with esbuild. Extension tests compile TypeScript to the CommonJS `out/` tree.

## Tech Stack

- Runtime: VS Code extension API `^1.107.0`, UI extension host, Node.js-compatible extension code, and browser-based webviews.
- Language: TypeScript targeting ES2022 with `module: Node16`, strict type checking, and DOM library types for webview code.
- Extension surfaces: `package.json` contributions for activity bar views, webviews, commands, settings, walkthroughs, localization, and the `insights_getCopilotQuota` language model tool.
- UI: VS Code webview HTML/CSS/JavaScript in `src/ui/webview/` and `media/`, VS Code theme variables, Codicons, and offline local assets.
- Charts: Chart.js 4.x via the bundled UMD asset at `media/chart.umd.min.js`.
- Build tooling: npm scripts, esbuild for `dist/extension.js`, TypeScript compiler for type checks and test emits, and `scripts/copy-codicons.mjs` for static assets.
- Quality and tests: ESLint 9 with typescript-eslint, Mocha-style extension tests through `@vscode/test-cli` and `@vscode/test-electron`, plus `@types/vscode`, `@types/node`, and `@types/mocha`.

## Code Style

- Make focused TypeScript changes that match nearby style and avoid broad rewrites or formatting churn.
- Preserve public command IDs, setting keys, view IDs, contribution IDs, exported types, and storage shapes unless the task explicitly requires a migration or breaking change.
- Prefer pure helpers in `src/core/` for behavior that can be unit tested without the VS Code API.
- Keep user-facing strings localizable through the existing package/l10n patterns when they are surfaced by VS Code or the extension UI.

## VS Code Extension Rules

- Treat `package.json` contributions, activation behavior, command registration, status bar items, language model tools, storage, and webviews as public extension surfaces.
- Do not use proposed VS Code APIs unless the project already opts into them or the user explicitly asks.
- Do not assume webview code can access Node.js or the VS Code API directly. Use `acquireVsCodeApi`, message passing, CSP nonces, and `asWebviewUri` for local assets.
- Keep webview rendering compatible with VS Code themes and offline local assets.

## Build and Test

- Use `npm run compile` as the main production validation command after extension changes.
- Run `npm run compile-tests` when changing tests or code imported by tests.
- Run `npm test` only when the Electron extension test harness is needed and practical; if it is blocked by the VS Code download or environment, report that extension-host behavior remains unverified.
- Follow `.github/instructions/repo-validation.instructions.md` for the detailed validation workflow when it applies.

## Repository Discipline

- Do not publish, package for release, bump versions, commit, or create branches unless the user explicitly asks.
- Do not revert user changes. If existing edits affect the task, work with them and keep the final summary clear about what changed.
- Keep documentation updates close to the behavior being changed; do not duplicate large sections from `README.md`.