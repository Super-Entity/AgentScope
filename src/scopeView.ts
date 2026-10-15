import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SelectionState } from './core/selection';
import { ModuleConfig } from './types';

export interface PermissionRow {
  target?: 'project' | 'resource';
  name: string;
  relative: string;
  label: string;
  directory: boolean;
  symbolicLink?: boolean;
  project: boolean;
  selectable?: boolean;
  read: SelectionState;
  write: SelectionState;
  enabled?: boolean;
  hidden?: boolean;
  instruction?: string | null;
  scope?: ModuleConfig;
}

export interface ScopeViewModel {
  workspaceId: number;
  workspace: string | null;
  caseSensitive: boolean;
  trusted: boolean;
  busy: boolean;
  dirty: boolean;
  message: string;
  configurationError?: string | null;
  recoveryAvailable?: boolean;
  restoreAvailable?: boolean;
  projects: PermissionRow[];
  resources?: PermissionRow;
  resourceHidden?: Record<string, boolean>;
  preset?: string | null;
  scopeNotice?: string;
  promptPresetForNewChat?: boolean;
}

export class ScopeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private listeners: vscode.Disposable[] = [];
  private refreshQueued = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: unknown) => Promise<void>,
    private readonly getModel: () => ScopeViewModel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.releaseListeners();
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.listeners.push(view.webview.onDidReceiveMessage((message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') this.refresh();
      return this.onMessage(message).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`AgentScope: ${reason}`);
        this.refresh();
      });
    }));
    this.listeners.push(view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.releaseListeners();
      }
    }));
    this.refresh();
  }

  refresh(): void {
    if (!this.view || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      void (async () => {
        if (this.view) await this.send({ type: 'state', state: this.getModel() });
      })().catch(() => undefined);
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.view) await this.view.webview.postMessage(message);
  }

  dispose(): void {
    this.view = undefined;
    this.releaseListeners();
  }

  private releaseListeners(): void {
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(24).toString('hex');
    const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
    const script = escape(webview.asWebviewUri(vscode.Uri.joinPath(media, 'scopes.js')).toString());
    const stylesheet = escape(webview.asWebviewUri(vscode.Uri.joinPath(media, 'scopes.css')).toString());
    const source = escape(webview.cspSource);
    const icon = (shapes: string): string => `<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes}</svg>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <link rel="stylesheet" href="${stylesheet}">
  <title>AgentScope permissions</title>
</head>
<body>
  <header>
    <button id="workspace" class="workspace" data-command="selectWorkspace" title="Select the workspace folder to manage">Select workspace</button>
    <div class="toolbar" role="toolbar" aria-label="Workspace actions">
      <button class="icon-button" data-command="refresh" title="Refresh configuration" aria-label="Refresh configuration">${icon('<path d="M20 5v5h-5M20 10a8 8 0 1 0 0 4"/>')}<span class="sr-only">Refresh</span></button>
      <button class="icon-button" id="collapse-all" title="Collapse all expanded projects and workspace folders" aria-label="Collapse all expanded folders">${icon('<path d="m7 10 5-5 5 5M7 19l5-5 5 5"/>')}<span class="sr-only">Collapse all</span></button>
      <button class="icon-button" data-command="addFolder" title="Add workspace folders as projects; Git is optional" aria-label="Add workspace folders">${icon('<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 14h6m-3-3v6"/>')}<span class="sr-only">Add</span></button>
      <button class="icon-button" data-command="preview" title="Preview configuration changes" aria-label="Preview configuration changes">${icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')}<span class="sr-only">Preview</span></button>
      <details class="more apply-menu">
        <summary class="icon-button primary" title="Apply or preview changes" aria-label="Apply or preview changes">${icon('<path d="m5 12 4 4L19 6"/>')}<span class="sr-only">Apply</span></summary>
        <div class="more-actions">
          <button data-command="apply">Apply changes</button>
          <button data-command="preview">Preview changes</button>
        </div>
      </details>
      <details class="more presets">
        <summary class="icon-button" title="Manage saved workspace presets" aria-label="Manage saved workspace presets">${icon('<path d="M6 3h12v18l-6-4-6 4Z"/>')}<span class="sr-only">Presets</span></summary>
        <div class="more-actions">
          <button data-command="toggleNewChatPresetPrompt" id="new-chat-preset-prompt" role="menuitemcheckbox" aria-checked="false">Prompt for preset with Ctrl+N</button>
          <button data-command="savePreset">Save preset…</button>
          <button data-command="updatePreset">Update preset…</button>
          <button data-command="activatePreset">Activate preset…</button>
          <button data-command="deletePreset">Delete preset…</button>
        </div>
      </details>
      <details class="more">
        <summary class="icon-button" title="More workspace actions" aria-label="More workspace actions">${icon('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>')}<span class="sr-only">More</span></summary>
        <div class="more-actions">
          <button data-command="sharedPaths">Workspace resources</button>
          <button data-command="recover" title="Restore the last saved AgentScope selections">Recover saved configuration</button>
          <button data-command="reconfigure" title="Start fresh Read and Write selections, then Apply">Reconfigure access</button>
          <button data-command="restore">Restore last apply</button>
          <button data-command="openConfiguration">Open AgentScope configuration</button>
          <button data-command="openCodex">Open Codex config</button>
        </div>
      </details>
    </div>
  </header>
  <button id="new-codex-chat" class="new-chat primary" data-command="newChat">New Codex chat</button>
  <p class="chat-help">Choose a preset, then select it in Codex Permissions.</p>
  <p id="status" role="status" aria-live="polite">Loading workspace…</p>
  <p id="preset" class="preset-status" role="status" aria-live="polite" hidden></p>
  <p id="notice" class="notice" hidden></p>
  <p id="configuration-actions" class="configuration-actions" hidden><button type="button" class="link-button" data-command="reconfigure" title="Start fresh Read and Write selections, then Apply">Reconfigure access</button><button id="recover-saved" type="button" class="link-button" data-command="recover" title="Restore the last saved AgentScope selections" hidden>Recover saved configuration</button></p>
  <div class="table-wrap">
    <table id="permissions" role="treegrid" aria-label="Project and workspace file permissions">
      <thead><tr><th scope="col">Folder / path</th><th scope="col" class="permission-heading">Read</th><th scope="col" class="permission-heading">Write</th><th scope="col"><span class="sr-only">Path actions</span></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <details id="sandbox-details" class="sandbox-details" hidden>
    <summary>Sandbox details</summary>
    <p id="scope-notice"></p>
  </details>
  <p class="help">Ordinary folders and Git submodules use the same controls. Folder checks include descendants. Write also permits Read. Changes stay in the draft until Apply.</p>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
