---
description: "Use when: changing, validating, testing, or reviewing this VS Code extension repository. Covers npm compile, lint, test harness, Electron test caveats, and build output."
name: "Repo Validation Workflow"
applyTo: "src/**/*.ts, package.json, esbuild.mjs, scripts/**/*.mjs, .github/workflows/**/*.yml"
---
# Repo Validation Workflow

- Treat `npm run compile` as the required production validation gate for extension changes. It runs asset copying, `tsc --noEmit`, ESLint, and esbuild.
- Run `npm run compile-tests` when changing tests or logic that extension tests import. It emits the CommonJS `out/` tree used by the VS Code test harness.
- Start with the narrowest relevant behavior check, then broaden only when the changed surface warrants it.
- Remember that `npm test` uses `@vscode/test-electron` and can download a full VS Code build. If the Electron harness is blocked or too slow, run `npm run compile` and `npm run compile-tests`, then clearly report that extension-host behavior remains unverified.
- Do not delete `out/` while a watch or compiler task is running. Re-run `npm run compile` or stop the watcher before cleaning generated output.
