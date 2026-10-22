import * as vscode from "vscode";
import { AttributionMode } from "../types";

/**
 * Resolves what this window currently has in the foreground, for credit
 * attribution: which project, and which git branch.
 */

/**
 * The slice of the built-in Git extension's API this needs. Typed structurally
 * so the extension carries no dependency on `vscode.git` and degrades to "no
 * branch" whenever it is unavailable, disabled, or changes shape.
 */
interface GitRepositoryLike {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string }; onDidChange?: vscode.Event<void> };
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
  onDidOpenRepository?: vscode.Event<GitRepositoryLike>;
  onDidCloseRepository?: vscode.Event<GitRepositoryLike>;
}

interface GitExtensionLike {
  getAPI(version: number): GitApiLike;
}

/** The foreground project and branch. Either may be `""` when unknown. */
export interface WorkspaceContext {
  project: string;
  branch: string;
}

/**
 * The workspace folder the user is most plausibly working in: the one holding
 * the active editor, falling back to the only (or first) folder open.
 */
function activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const owning = vscode.workspace.getWorkspaceFolder(activeUri);
    if (owning) {
      return owning;
    }
  }

  return folders[0];
}

/**
 * The git branch checked out in `folder`, via the built-in Git extension.
 * Returns `""` whenever the extension is unavailable or the folder is not a
 * repository — attribution then records the project alone.
 */
function resolveBranch(folder: vscode.WorkspaceFolder | undefined): string {
  if (!folder) {
    return "";
  }

  try {
    const extension = vscode.extensions.getExtension<GitExtensionLike>("vscode.git");
    // Only read an already-activated extension: activating it from a
    // background poll would be a surprising side effect.
    if (!extension?.isActive) {
      return "";
    }

    const repositories = extension.exports.getAPI(1).repositories;
    const folderPath = folder.uri.fsPath;
    const repository =
      repositories.find((candidate) => candidate.rootUri.fsPath === folderPath) ??
      // Fall back to a repository that contains the folder (a subfolder of a
      // repo root is still that repo's branch).
      repositories.find((candidate) => folderPath.startsWith(candidate.rootUri.fsPath));

    return repository?.state.HEAD?.name ?? "";
  } catch {
    // The Git extension's API is not part of our contract; never let a change
    // in it break a data refresh.
    return "";
  }
}

/**
 * Resolves the current foreground context for the given attribution mode.
 * Returns empty strings for anything the mode excludes or that cannot be
 * determined.
 */
export function resolveWorkspaceContext(mode: AttributionMode): WorkspaceContext {
  if (mode === "off") {
    return { project: "", branch: "" };
  }

  const folder = activeWorkspaceFolder();
  // `workspace.name` covers a multi-root .code-workspace, which has no single
  // folder that represents it.
  const project = folder?.name ?? vscode.workspace.name ?? "";

  return {
    project,
    branch: mode === "project-and-branch" ? resolveBranch(folder) : "",
  };
}

/** Invalidates the entire interval on context transitions, even A → B → A. */
export class WorkspaceIntervalTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositories = new Set<GitRepositoryLike>();
  private api?: GitApiLike;
  private signature = "";
  private stable = false;

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.check()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.stable = false; this.check(); }),
      vscode.extensions.onDidChange(() => { this.stable = false; this.connect(); }),
    );
    this.connect();
  }

  private current(): string {
    const context = resolveWorkspaceContext("project-and-branch");
    return JSON.stringify([activeWorkspaceFolder()?.uri.toString(), context.project, context.branch]);
  }

  private check(): void {
    const next = this.current();
    if (next !== this.signature) { this.stable = false; }
    this.signature = next;
  }

  private connect(): void {
    try {
      const extension = vscode.extensions.getExtension<GitExtensionLike>("vscode.git");
      if (!extension?.isActive) { return; }
      const api = extension.exports.getAPI(1);
      const watch = (repo: GitRepositoryLike) => {
        if (this.repositories.has(repo)) { return; }
        this.repositories.add(repo);
        this.stable = false;
        if (repo.state.onDidChange) {
          this.disposables.push(repo.state.onDidChange(() => this.check()));
        }
      };
      if (this.api !== api) {
        this.api = api;
        if (api.onDidOpenRepository) { this.disposables.push(api.onDidOpenRepository(watch)); }
        if (api.onDidCloseRepository) { this.disposables.push(api.onDidCloseRepository(() => { this.stable = false; })); }
      }
      api.repositories.forEach(watch);
      if (api.repositories.some(repo => !repo.state.onDidChange)) { this.stable = false; }
    } catch {
      // An unavailable/changed Git API must not break refreshes or justify attribution.
      this.stable = false;
    }
  }

  isStable(): boolean {
    this.connect();
    this.check();
    return this.stable;
  }

  reset(): void { this.signature = this.current(); this.stable = true; }
  invalidate(): void { this.stable = false; }
  dispose(): void { this.disposables.forEach(item => item.dispose()); }
}
