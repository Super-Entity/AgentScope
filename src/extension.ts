import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadWorkspace, loadWorkspaceForReconfiguration, buildApplyPlan, ApplyOptions } from './workspace';
import { applyPlan, restoreChanges } from './transactions';
import { assertDirectoryIdentity, captureDirectoryIdentity, normalizeRelative, resolveContained, verifyContained } from './core/paths';
import { ACCESS_POLICY_FILE, readAccessRegistry, validateRegistry } from './core/registry';
import { PolicyCheckpoint, checkpointKey, createCheckpoint, validateCheckpoint, checkpointFromLastApply, buildPolicyRecoveryPlan } from './recovery';
import { selectedState, selectionReader, togglePathSelection, AccessKind, SelectionChild, SelectionState } from './core/selection';
import { inspectProjectEntry, listProjectChildren } from './browse';
import { isResourcePath, listWorkspaceChildren, listWorkspaceSelectionRoots, workspaceSelectionState, resourceScope, toggleResourceSelection, toggleWorkspaceSelection, ResourceChild } from './resources';
import { readPresetsSnapshot, validatePresetName, writePreset, deletePreset, ScopePreset } from './presets';
import { ScopeView, ScopeViewModel, PermissionRow } from './scopeView';
import { ApplyPlan, FileChange, WorkspaceState } from './types';
import { CodexFilesystemMode, CodexRuntime, resolveFilesystemMode, runtimeWorkspaceRoot } from './core/runtimePaths';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE } from './configuration';
import { chooseAndOpenScopedChat } from './chatEntry';
import { detectWindowsSandbox } from './windowsSandbox';
import { assertWorkspaceLocation, WorkspaceLocationError } from './workspaceLocation';

type ScopeNode = { kind: 'module'; name: string };

class PreviewDocuments implements vscode.TextDocumentContentProvider {
  readonly documents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string { return this.documents.get(uri.toString()) ?? ''; }
  dispose(): void { this.documents.clear(); }
}

export function activate(context: vscode.ExtensionContext): void {
  let currentState: WorkspaceState | undefined;
  let selectedWorkspaceRoot: string | undefined;
  let selectedWorkspaceFolderPath: string | undefined;
  let configurationError: string | null = null;
  let workspaceUnavailable = false;
  let recoveryCheckpoint: PolicyCheckpoint | undefined;
  let workspaceSelectionRoots: ResourceChild[] = [];
  let watchedWorkspaceRoot: string | undefined;
  let queuedReloadRoot: string | undefined;
  let queuedWorkspaceReconciliation = false;
  let disposed = false;
  let workspaceId = 0;
  const view = new ScopeView(context.extensionUri, receiveMessage, viewModel);
  const previews = new PreviewDocuments();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'agentscope.preview';
  let watchers: vscode.FileSystemWatcher[] = [];
  let writing = false;
  let loading = false;
  let messageQueue = Promise.resolve();
  let selectingPaths = false;
  let startingChat = false;
  let selectedPreset: string | null = null;
  let presetOptions: ApplyOptions | undefined;

  function permissionRow(name: string, relative: string, directory: boolean, project = false, symbolicLink?: boolean,
    selection?: { read: SelectionState; write: SelectionState }): PermissionRow {
    const module = state().registry.submodules[name];
    return {
      name, relative, label: project ? name : path.posix.basename(relative), directory, project, symbolicLink,
      read: selection?.read ?? selectedState(module, relative, 'read'), write: selection?.write ?? selectedState(module, relative, 'write'),
      ...(project ? {
        enabled: module.enabled, hidden: state().hidden[name] === true,
        scope: { path: module.path, enabled: module.enabled, restrict_paths: module.restrict_paths,
          read_paths: [...module.read_paths], write_paths: [...module.write_paths], instruction_file: module.instruction_file },
      } : {}),
    };
  }

  function hasWorkspaceResources(): boolean {
    return !!currentState && !Object.values(currentState.registry.submodules).some(module => normalizeRelative(module.path) === '.');
  }

  function workspaceResourceRow(relative: string, directory: boolean, selectable: boolean, symbolicLink?: boolean,
    selection?: { read: SelectionState; write: SelectionState }): PermissionRow {
    const scope = relative === '.' || !selection ? resourceScope(state().registry) : undefined;
    return {
      target: 'resource', name: '@workspace', relative, label: relative === '.' ? 'Workspace files' : path.posix.basename(relative),
      directory, project: false, selectable, symbolicLink, hidden: state().resourceHidden?.[relative] === true,
      read: relative === '.' ? workspaceSelectionState(state().registry, workspaceSelectionRoots, 'read') : selection?.read ?? selectedState(scope!, relative, 'read'),
      write: relative === '.' ? workspaceSelectionState(state().registry, workspaceSelectionRoots, 'write') : selection?.write ?? selectedState(scope!, relative, 'write'),
      ...(relative === '.' ? { scope } : {}),
    };
  }

  function viewModel(): ScopeViewModel {
    const selectedRoot = currentState?.root ?? selectedWorkspaceRoot;
    let restoreAvailable = false;
    if (selectedRoot) {
      try { undoBackup(selectedRoot, context.workspaceState.get(`backup:${selectedRoot}`)); restoreAvailable = true; }
      catch { /* Invalid or unrelated cached paths must not enable Restore. */ }
    }
    return {
      workspaceId, workspace: selectedRoot ? path.basename(selectedRoot) || selectedRoot : null,
      workspacePath: selectedRoot, codexWorkspacePath: configuredCodexWorkspacePath(), workspaceUnavailable,
      caseSensitive: process.platform !== 'win32', trusted: vscode.workspace.isTrusted,
      busy: writing || loading || selectingPaths || startingChat, dirty: currentState?.dirty === true,
      configurationError,
      recoveryAvailable: !!recoveryCheckpoint && recoveryCheckpoint.root === selectedRoot,
      restoreAvailable,
      message: configurationError ?? (!currentState ? (vscode.workspace.workspaceFolders?.length ? 'Select an open local workspace folder to manage its scopes.' : 'Open a local folder to manage its scopes.') :
        !vscode.workspace.isTrusted ? 'Trust this workspace to change its configuration.' :
        currentState.warnings.length ? currentState.warnings.join('\n') :
        currentState.dirty ? 'Draft changes. Preview or Apply to save.' :
        'Expand folders to select files. Writing includes reading. Apply saves changes.'),
      projects: currentState ? Object.keys(currentState.registry.submodules).sort().map(name => permissionRow(name, '.', true, true)) : [],
      ...(hasWorkspaceResources() ? { resources: workspaceResourceRow('.', true, workspaceSelectionRoots.length > 0) } : {}),
      resourceHidden: currentState?.resourceHidden ?? {},
      preset: selectedPreset,
      scopeNotice: scopeNotice(),
      promptPresetForNewChat: !!currentState && vscode.workspace.getConfiguration('agentscope', vscode.Uri.file(currentState.root)).get<boolean>('promptPresetForNewChat', false),
    };
  }

  function update(): void {
    view.refresh();
    if (currentState || selectedWorkspaceRoot) {
      status.text = configurationError ? '$(warning) AgentScope' : `$(shield) AgentScope${currentState?.dirty ? ' *' : ''}`;
      status.tooltip = configurationError ?? (currentState?.dirty ? 'Preview pending workspace scope changes' : 'Preview workspace scopes');
      status.command = currentState ? 'agentscope.preview' : 'agentscope.refresh';
      status.show();
    } else { status.hide(); }
  }

  function trusted(allowStartingChat = false): void {
    if (startingChat && allowStartingChat !== true) throw new Error('Wait for the new Codex chat operation to finish.');
    if (loading) { throw new Error('Wait for the workspace to finish loading before editing scopes.'); }
    if (writing) { throw new Error('Wait for the current configuration operation to finish before editing scopes.'); }
    if (selectingPaths) { throw new Error('Wait for the current path selection to finish.'); }
    if (!vscode.workspace.isTrusted) { throw new Error('Trust the workspace before changing access settings.'); }
  }

  function state(): WorkspaceState {
    if (!currentState) { throw new Error(workspaceUnavailable ? configurationError! : configurationError ? `Fix the workspace configuration before editing scopes: ${configurationError}` : 'Open and select a local workspace folder first.'); }
    return currentState;
  }

  async function pickWorkspace(force = false): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { return undefined; }
    if (!force && folders.length === 1) { return folders[0].uri.fsPath; }
    const selection = await vscode.window.showQuickPick(folders.map(folder => ({
      label: folder.name, description: folder.uri.fsPath, folder,
    })), { title: 'AgentScope: Select workspace folder', placeHolder: 'Configuration applies only to the selected workspace folder.' });
    return selection?.folder.uri.fsPath;
  }

  function configurationChanged(root: string): void {
    if (disposed) return;
    if (writing || loading || selectingPaths || startingChat) { queuedReloadRoot = root; return; }
    if (currentState?.dirty) {
      const warning = 'Workspace configuration changed outside AgentScope. Refresh before applying.';
      if (!currentState.warnings.includes(warning)) currentState.warnings.push(warning);
      update();
    } else { void guarded(() => load(root, true), false); }
  }

  function watchConfiguration(root: string): void {
    if (watchedWorkspaceRoot === root && watchers.length) return;
    for (const watcher of watchers) watcher.dispose();
    watchedWorkspaceRoot = root;
    queuedReloadRoot = undefined;
    watchers = [SCOPE_CONFIGURATION_FILE, '.vscode/agentscope-presets.json', '.gitmodules', '.vscode/settings.json', '.codex/config.toml'].map(file => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, file));
      const changed = () => { if (watchedWorkspaceRoot === root) configurationChanged(root); };
      watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
      return watcher;
    });
  }

  async function readSavedCheckpoint(root: string): Promise<void> {
    recoveryCheckpoint = undefined;
    const key = checkpointKey(root);
    try { recoveryCheckpoint = validateCheckpoint(context.globalState.get(key), root); }
    catch { /* A malformed or foreign checkpoint cannot authorize recovery. */ }
    if (!recoveryCheckpoint && context.globalState.get(`${key}.pending`) === undefined) {
      const imported = checkpointFromLastApply(root, context.workspaceState.get(`backup:${root}`));
      if (imported) {
        await context.globalState.update(key, imported);
        recoveryCheckpoint = imported;
      }
    }
  }

  async function rememberCheckpoint(current: WorkspaceState): Promise<void> {
    const checkpoint = createCheckpoint(current);
    if (!checkpoint) return;
    if (recoveryCheckpoint?.root === checkpoint.root && recoveryCheckpoint.configuration === checkpoint.configuration) return;
    await context.globalState.update(checkpointKey(current.root), checkpoint);
    recoveryCheckpoint = checkpoint;
  }

  async function refreshWorkspaceSelectionRoots(current: WorkspaceState): Promise<void> {
    workspaceSelectionRoots = [];
    if (Object.values(current.registry.submodules).some(module => normalizeRelative(module.path) === '.')) return;
    try {
      const roots = await listWorkspaceSelectionRoots(current.root, current.registry);
      if (currentState === current) workspaceSelectionRoots = roots;
    } catch (error) {
      const warning = `Workspace files selection could not be listed safely: ${errorMessage(error)}`;
      if (!current.warnings.includes(warning)) current.warnings.push(warning);
    }
  }

  function finishPathSelection(): void {
    selectingPaths = false; update();
    drainDeferredChanges();
  }

  function finishWriting(): void {
    writing = false; update();
    drainDeferredChanges();
  }

  function drainDeferredChanges(): void {
    if (disposed || writing || loading || selectingPaths || startingChat) return;
    if (queuedWorkspaceReconciliation) {
      queuedWorkspaceReconciliation = false;
      reconcileWorkspaceFolders();
    }
    const queued = queuedReloadRoot; queuedReloadRoot = undefined;
    if (queued && queued === watchedWorkspaceRoot && !disposed) configurationChanged(queued);
  }

  function workspaceIsOpen(): boolean {
    return !!selectedWorkspaceFolderPath && !!vscode.workspace.workspaceFolders?.some(folder =>
      folder.uri.scheme === 'file' && sameConfigurationPath(folder.uri.fsPath, selectedWorkspaceFolderPath!));
  }

  function ensureWorkspaceOpen(root: string): void {
    if (disposed || !selectedWorkspaceRoot || !sameConfigurationPath(root, selectedWorkspaceRoot) || !workspaceIsOpen()) {
      throw new Error('The selected workspace folder is no longer open. Select an open workspace before changing configuration.');
    }
  }

  async function ensureWritableWorkspace(current: WorkspaceState): Promise<void> {
    ensureWorkspace(current);
    await assertWorkspaceLocation(selectedWorkspaceFolderPath!);
    const origin = await verifyContained(selectedWorkspaceFolderPath!, selectedWorkspaceFolderPath!);
    if (!sameConfigurationPath(origin, current.root)) throw new Error('The selected workspace folder changed through a link. Select it again before changing configuration.');
    if (current.rootIdentity) await assertDirectoryIdentity(current.root, current.rootIdentity);
    ensureWorkspace(current);
  }

  function clearWorkspace(): void {
    currentState = undefined; selectedWorkspaceRoot = undefined; selectedWorkspaceFolderPath = undefined;
    configurationError = null; recoveryCheckpoint = undefined; workspaceSelectionRoots = [];
    workspaceUnavailable = false;
    selectedPreset = null; presetOptions = undefined;
    for (const watcher of watchers) watcher.dispose();
    watchers = []; watchedWorkspaceRoot = undefined; queuedReloadRoot = undefined;
    workspaceId++; update();
  }

  function reconcileWorkspaceFolders(): void {
    if (!selectedWorkspaceFolderPath || workspaceIsOpen()) return;
    clearWorkspace();
  }

  function ensureWorkspace(current: WorkspaceState): void {
    if (currentState !== current || disposed) throw new Error('The workspace changed while choosing settings. Refresh and try again.');
    ensureWorkspaceOpen(current.root);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before changing access settings.');
  }

  async function load(root?: string, preserveMatchingPreset = false): Promise<void> {
    if (disposed) return;
    if (loading) { if (root) queuedReloadRoot = root; return; }
    const selected = root ?? await pickWorkspace();
    if (!selected) {
      clearWorkspace(); return;
    }
    const origin = selectedWorkspaceRoot && sameConfigurationPath(selected, selectedWorkspaceRoot)
      ? selectedWorkspaceFolderPath ?? selected : selected;
    if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file' && sameConfigurationPath(folder.uri.fsPath, origin))) {
      reconcileWorkspaceFolders();
      throw new Error('The selected workspace folder is no longer open. Select an open workspace to continue.');
    }
    const previous = currentState;
    const previousPreset = selectedPreset;
    const previousOptions = presetOptions;
    selectedWorkspaceFolderPath = origin;
    selectedWorkspaceRoot = selected;
    recoveryCheckpoint = undefined;
    loading = true;
    update();
    try {
      // Keep observing the selected folder even when its configuration needs repair.
      await assertWorkspaceLocation(selected);
      const canonicalSelected = await verifyContained(selected, selected);
      selectedWorkspaceRoot = canonicalSelected;
      watchConfiguration(canonicalSelected);
      const recoveryWarnings: string[] = [];
      try { await readSavedCheckpoint(canonicalSelected); }
      catch (error) { recoveryWarnings.push(`Recovery storage could not be read: ${errorMessage(error)}`); }
      const loadedState = await loadWorkspace(canonicalSelected);
      loadedState.warnings.push(...recoveryWarnings);
      if (disposed) return;
      ensureWorkspaceOpen(canonicalSelected);
      currentState = loadedState;
      await refreshWorkspaceSelectionRoots(currentState);
      selectedWorkspaceRoot = currentState.root;
      configurationError = null;
      workspaceUnavailable = false;
      selectedPreset = null; presetOptions = undefined;
      if (preserveMatchingPreset && previous && sameConfigurationPath(previous.root, loadedState.root) &&
        isDeepStrictEqual(previous.registry, loadedState.registry) && isDeepStrictEqual(previous.hidden, loadedState.hidden) &&
        isDeepStrictEqual(previous.resourceHidden ?? {}, loadedState.resourceHidden ?? {})) {
        selectedPreset = previousPreset; presetOptions = previousOptions;
      }
      workspaceId++;
      try { await rememberCheckpoint(currentState); }
      catch (error) { currentState.warnings.push(`Recovery storage could not be saved: ${errorMessage(error)}`); }
    } catch (error) {
      // A missing or invalid policy must not leave stale grants or directory responses active.
      currentState = undefined;
      workspaceSelectionRoots = [];
      configurationError = errorMessage(error);
      workspaceUnavailable = error instanceof WorkspaceLocationError;
      selectedPreset = null; presetOptions = undefined;
      workspaceId++;
      throw error;
    } finally {
      loading = false; update();
      drainDeferredChanges();
    }
  }

  function draft(): void { state().dirty = true; selectedPreset = null; update(); }

  async function moduleName(node?: ScopeNode): Promise<string | undefined> {
    if (node?.kind === 'module') { return node.name; }
    return vscode.window.showQuickPick(Object.keys(state().registry.submodules).sort(), {
      title: 'AgentScope: Select project',
    });
  }

  async function editPaths(name: string, kind: 'read_paths' | 'write_paths'): Promise<void> {
    const current = state();
    const module = current.registry.submodules[name];
    const base = resolveContained(current.root, module.path);
    for (;;) {
      const action = await vscode.window.showQuickPick([
        { label: 'Add folder', id: 'folder' }, { label: 'Add file', id: 'file' },
        { label: 'Add entire project', id: 'whole' }, { label: 'Remove a path', id: 'remove' },
        { label: 'Done', id: 'done' },
      ], { title: `${name}: ${kind === 'read_paths' ? 'Read' : 'Write'} paths`,
        placeHolder: module[kind].length ? module[kind].join(' · ') : 'No paths allowed' });
      if (!action || action.id === 'done') { return; }
      ensureWorkspace(current);
      if (action.id === 'remove') {
        const remove = await vscode.window.showQuickPick(module[kind], { title: 'Select path to remove' });
        ensureWorkspace(current);
        if (remove !== undefined) { module[kind] = module[kind].filter(value => value !== remove); draft(); }
        continue;
      }
      if (action.id === 'whole') {
        module[kind] = ['.']; module.restrict_paths = true; draft(); continue;
      }
      const selections = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(base), canSelectMany: true,
        canSelectFiles: action.id === 'file', canSelectFolders: action.id === 'folder',
        openLabel: 'Allow selected paths', title: `Select paths inside ${name}`,
      });
      if (!selections) { continue; }
      ensureWorkspace(current);
      for (const selection of selections) {
        const relative = normalizeRelative(path.relative(base, selection.fsPath) || '.');
        const absolute = resolveContained(base, relative);
        await verifyContained(base, absolute);
        if (!module[kind].includes(relative)) { module[kind].push(relative); }
      }
      module.restrict_paths = true; draft();
    }
  }

  async function accessMode(name: string): Promise<void> {
    const current = state();
    const module = state().registry.submodules[name];
    const choice = await vscode.window.showQuickPick([
      { label: 'Disabled', description: 'No agent access', id: 'disabled' },
      { label: 'Read only', description: 'Read the entire project', id: 'read' },
      { label: 'Restricted paths', description: 'Choose readable and writable paths', id: 'restricted' },
      { label: 'Read and write', description: 'Allow the entire project', id: 'write' },
    ], { title: `${name}: Agent access` });
    ensureWorkspace(current);
    if (!choice) { return; }
    if (choice.id === 'disabled') { module.enabled = false; }
    else if (choice.id === 'read') {
      module.enabled = true; module.restrict_paths = true; module.read_paths = ['.']; module.write_paths = [];
    } else if (choice.id === 'write') { module.enabled = true; module.restrict_paths = false; }
    else {
      module.enabled = true; module.restrict_paths = true;
      await editPaths(name, 'read_paths'); await editPaths(name, 'write_paths');
    }
    draft();
  }

  async function configure(node?: ScopeNode): Promise<void> {
    trusted();
    const current = state();
    selectingPaths = true; update();
    try {
      const name = await moduleName(node);
      ensureWorkspace(current);
      if (!name) { return; }
      if (!Object.hasOwn(current.registry.submodules, name)) throw new Error('This project is not registered in the selected workspace.');
      for (;;) {
        const module = state().registry.submodules[name];
        const action = await vscode.window.showQuickPick([
          { label: 'Agent access', id: 'access', description: module.enabled ? 'Enabled' : 'Disabled' },
          { label: 'Read paths', id: 'read', description: module.read_paths.join(', ') || 'None' },
          { label: 'Write paths', id: 'write', description: module.write_paths.join(', ') || 'None' },
          { label: 'Folder visibility', id: 'visibility', description: state().hidden[name] ? 'Hidden' : 'Visible' },
          { label: 'Done', id: 'done' },
        ], { title: `AgentScope: ${name}` });
        ensureWorkspace(current);
        if (!action || action.id === 'done') { return; }
        if (action.id === 'access') { await accessMode(name); }
        else if (action.id === 'read') { await editPaths(name, 'read_paths'); }
        else if (action.id === 'write') { await editPaths(name, 'write_paths'); }
        else {
          if (module.path === '.') { throw new Error('The open workspace root cannot be hidden. Manage visibility for its child projects instead.'); }
          state().hidden[name] = !state().hidden[name]; draft();
        }
      }
    } finally { await refreshWorkspaceSelectionRoots(current); finishPathSelection(); }
  }

  async function addFolder(): Promise<void> {
    trusted();
    const current = state();
    selectingPaths = true; update();
    try {
      const chosen = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(current.root),
        canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add projects' });
      ensureWorkspace(current);
      if (!chosen?.length) { return; }
      const paths: string[] = [];
      for (const folder of chosen) {
        if (folder.scheme !== 'file') throw new Error('Projects must be local folders within the selected workspace.');
        const relative = normalizeRelative(path.relative(current.root, folder.fsPath) || '.');
        const canonical = await verifyContained(current.root, resolveContained(current.root, relative));
        if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Select a project folder.');
        ensureWorkspace(current);
        paths.push(relative);
      }
      const candidate = { ...current.registry, submodules: { ...current.registry.submodules } };
      const hidden = { ...current.hidden };
      // An untouched disabled root is only an initial placeholder. Splitting it
      // into child projects must never transfer a previous root access choice.
      if (paths.every(relative => relative !== '.')) {
        const fields = ['path', 'enabled', 'restrict_paths', 'read_paths', 'write_paths', 'instruction_file'];
        for (const [name, module] of Object.entries(candidate.submodules)) {
          if (normalizeRelative(module.path) === '.' && module.enabled === false && module.restrict_paths === true
            && module.read_paths.length === 0 && module.write_paths.length === 0 && module.instruction_file === null
            && Object.keys(module).every(field => fields.includes(field))) {
            delete candidate.submodules[name]; delete hidden[name];
          }
        }
      }
      const validateName = (value: string): string | undefined => !value.trim() ? 'A name is required.' :
        ['__proto__', 'constructor', 'prototype'].includes(value.trim()) || /[\x00-\x1f\x7f]/.test(value)
          ? 'Invalid project name. Use a project name without reserved object names or control characters.' :
          Object.hasOwn(candidate.submodules, value.trim()) ? 'This project name already exists.' : undefined;
      for (let index = 0; index < chosen.length; index++) {
        let name: string | undefined = path.basename(chosen[index].fsPath);
        if (chosen.length === 1 || validateName(name)) {
          name = await vscode.window.showInputBox({ title: 'AgentScope: Project name',
            prompt: paths[index], value: name, validateInput: validateName });
          ensureWorkspace(current);
        }
        if (!name) { return; }
        const invalidName = validateName(name);
        if (invalidName) throw new Error(invalidName);
        const key = name.trim();
        candidate.submodules[key] = { path: paths[index], enabled: false, restrict_paths: true,
          read_paths: [], write_paths: [], instruction_file: null };
        hidden[key] = false;
      }
      try { validateRegistry(candidate, current.root); }
      catch (error) {
        if (Object.values(candidate.submodules).some(module => normalizeRelative(module.path) === '.') && paths.some(relative => relative !== '.')) {
          throw new Error('The workspace root is already registered with configured scope choices. Remove that project entry before adding child projects, or manage its folders within the existing project.');
        }
        throw error;
      }
      current.registry = candidate;
      current.hidden = hidden; workspaceId++; draft();
    } finally { await refreshWorkspaceSelectionRoots(current); finishPathSelection(); }
  }

  function configuredOptions(): ApplyOptions {
    const config = vscode.workspace.getConfiguration('agentscope', vscode.Uri.file(state().root));
    return {
      generateCodexProfile: config.get<boolean>('generateCodexProfile', true),
      profileName: config.get<string>('profileName', 'agentscope'),
      excludeFromSearch: config.get<boolean>('excludeFromSearch', true),
      allowNetwork: config.get<boolean>('allowCommandNetwork', false),
      codexRuntime: config.get<CodexRuntime>('codexRuntime', 'auto'),
      codexWorkspaceRoot: config.get<string>('codexWorkspaceRoot', ''),
      codexFilesystemMode: config.get<CodexFilesystemMode>('codexFilesystemMode', 'auto'),
      codexWindowsSandbox: config.get<'auto' | 'mxc' | 'legacy'>('codexWindowsSandbox', 'auto'),
    };
  }

  function effectiveOptions(): ApplyOptions {
    // Older snapshots inherit settings added after they were saved.
    return { ...configuredOptions(), ...presetOptions };
  }

  function resolvedOptions(): ApplyOptions {
    const options = effectiveOptions();
    const runInWsl = vscode.workspace.getConfiguration('chatgpt', vscode.Uri.file(state().root))
      .get<boolean>('runCodexInWindowsSubsystemForLinux', false);
    return {
      ...options,
      codexRuntime: (options.codexRuntime ?? 'auto') === 'auto' && runInWsl ? 'wsl' : options.codexRuntime,
      codexAutoRuntime: runInWsl ? 'wsl' : 'native',
    };
  }

  function scopeNotice(): string | undefined {
    if (!currentState || configurationError) return undefined;
    try {
      const options = resolvedOptions();
      if (!options.generateCodexProfile) return undefined;
      const runtimeRoot = runtimeWorkspaceRoot(currentState.root, options.codexRuntime, options.codexWorkspaceRoot);
      if (resolveFilesystemMode(runtimeRoot, options.codexFilesystemMode) === 'windows-compatible') {
        return 'Native Windows: Apply verifies MXC support and uses strict isolation when available. The legacy fallback permits reads outside selected paths, including disabled projects; writes remain restricted. Preview shows the selected backend.';
      }
      if (resolveFilesystemMode(runtimeRoot) === 'windows-compatible') {
        return 'Strict read isolation on Windows requires a compatible sandbox such as MXC. Legacy Windows sandboxes may refuse to start; use Auto for Windows compatibility or run Codex in WSL2.';
      }
    } catch (error) { return errorMessage(error); }
    return undefined;
  }

  function configuredCodexWorkspacePath(): string | undefined {
    if (!currentState) return undefined;
    try {
      const options = resolvedOptions();
      return runtimeWorkspaceRoot(currentState.root, options.codexRuntime, options.codexWorkspaceRoot);
    } catch { return undefined; }
  }

  async function plan(options = resolvedOptions()): Promise<ApplyPlan> {
    const current = state();
    await ensureWritableWorkspace(current);
    const codexExtension = vscode.extensions?.getExtension('openai.chatgpt');
    const executable = process.platform === 'win32' && codexExtension
      ? path.join(codexExtension.extensionPath, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe') : undefined;
    const result = await buildApplyPlan(current, options, {
      detectWindowsSandbox: input => detectWindowsSandbox({ ...input, codexExecutable: executable }),
      presetDefaults: { ...configuredOptions(), codexAutoRuntime: options.codexAutoRuntime },
    });
    ensureWorkspace(current);
    assertSavedDocuments(result);
    return result;
  }

  function assertSavedDocuments(result: ApplyPlan): void {
    const dirtyDocument = vscode.workspace.textDocuments.find(document => document.isDirty && document.uri.scheme === 'file' &&
      [...result.changes, ...(result.checks ?? [])].some(input => sameConfigurationPath(input.path, document.uri.fsPath)));
    if (dirtyDocument) { throw new Error(`Save or discard changes in ${path.basename(dirtyDocument.fileName)} before applying scopes.`); }
  }

  function assertPresetSaved(root: string): void {
    const target = resolveContained(root, '.vscode/agentscope-presets.json');
    const document = vscode.workspace.textDocuments.find(candidate => candidate.isDirty && candidate.uri.scheme === 'file' &&
      sameConfigurationPath(target, candidate.uri.fsPath));
    if (document) throw new Error('Save or discard changes in agentscope-presets.json before saving or deleting a preset.');
  }

  async function validatePresetWrite(current: WorkspaceState): Promise<void> {
    await ensureWritableWorkspace(current);
    assertPresetSaved(current.root);
  }

  async function preview(result?: ApplyPlan): Promise<void> {
    if (!result && (writing || selectingPaths || loading || startingChat)) throw new Error('Wait for the current configuration operation before previewing changes.');
    const workspace = state();
    const ownsLock = !writing;
    if (ownsLock) { selectingPaths = true; update(); }
    try {
      const current = result ?? await plan();
      if (!current.changes.length) {
        vscode.window.showInformationMessage('AgentScope: No pending configuration changes. Edit Read/Write, visibility, or select a preset first.');
        return;
      }
      const details: Record<string, string> = {
        'AGENTS.md': 'Agent instructions and the reference to the access policy.',
        [SCOPE_CONFIGURATION_FILE]: 'AgentScope editor selections; runtime enforcement is in Codex config.toml.',
        '.vscode/settings.json': 'Explorer and Search visibility settings.',
        '.codex/config.toml': 'The generated Codex filesystem and network permission profile.',
      };
      const selected = await vscode.window.showQuickPick(current.changes.map((change, index) => ({
        label: path.relative(state().root, change.path), description: change.before === null ? 'New file' : 'Update', change, index,
        detail: details[path.relative(workspace.root, change.path).replace(/\\/g, '/')] ?? 'Workspace configuration change.',
      })), { title: 'AgentScope: Preview pending configuration changes', placeHolder: 'Choose a file to compare current (left) and proposed (right). Apply saves these changes.' });
      if (currentState !== workspace || disposed) throw new Error('The workspace changed while previewing configuration. Try again.');
      if (!selected) { return; }
      const suffix = `${Date.now()}-${selected.index}/${path.basename(selected.change.path)}`;
      const before = vscode.Uri.parse(`agentscope-preview:/before/${suffix}`);
      const after = vscode.Uri.parse(`agentscope-preview:/after/${suffix}`);
      previews.documents.set(before.toString(), selected.change.before ?? '');
      previews.documents.set(after.toString(), selected.change.after);
      await vscode.commands.executeCommand('vscode.diff', before, after, `AgentScope: ${selected.label}`, { preview: true });
    } finally { if (ownsLock) finishPathSelection(); }
  }

  async function apply(allowStartingChat = false): Promise<void> {
    trusted(allowStartingChat);
    const current = state();
    writing = true; update();
    try {
      const optionsSnapshot = resolvedOptions();
      const optionsBefore = JSON.stringify({ options: optionsSnapshot, defaults: configuredOptions() });
      const result = await plan(optionsSnapshot);
      const validateWrite = async () => {
        await ensureWritableWorkspace(current);
        assertSavedDocuments(result);
        if (JSON.stringify({ options: resolvedOptions(), defaults: configuredOptions() }) !== optionsBefore) {
          throw new Error('Codex runtime or AgentScope settings changed. Preview the updated configuration before applying again.');
        }
      };
      if (!result.changes.length) { await applyPlan(result, validateWrite); current.dirty = false; vscode.window.showInformationMessage('AgentScope: Configuration is already up to date.'); return; }
      const selection = await vscode.window.showInformationMessage(
        result.broadReadAccess
          ? `Apply Windows compatibility for ${path.basename(current.root)}? Files outside selected paths remain readable. ${result.changes.length} configuration files will change.`
          : `Save scope settings for ${path.basename(current.root)}? ${result.changes.length} configuration files will change.`,
        { modal: true, detail: `${result.warnings.join('\n')}\nExisting prose and unrelated settings are preserved. A running Codex session may need to restart before these settings take effect.`.trim() },
        'Apply', 'Preview',
      );
      if (selection === 'Preview') { await preview(result); return; }
      if (selection !== 'Apply') { return; }
      await ensureWritableWorkspace(current);
      assertSavedDocuments(result);
      const backupKey = `backup:${current.root}`;
      const previousBackup = context.workspaceState.get<FileChange[]>(backupKey);
      const savedKey = checkpointKey(current.root);
      const pendingKey = `${savedKey}.pending`;
      const previousCheckpoint = recoveryCheckpoint;
      const proposedFiles = { ...current.files };
      for (const change of result.changes) proposedFiles[change.path] = change.after;
      const proposedCheckpoint = createCheckpoint({ ...current, dirty: false, files: proposedFiles });
      if (!proposedCheckpoint) throw new Error('The proposed policy could not be saved as a valid recovery checkpoint.');
      // Keep the committed good checkpoint separate from this not-yet-applied copy.
      await context.globalState.update(pendingKey, proposedCheckpoint);
      try {
        await context.workspaceState.update(backupKey, result.changes);
        await applyPlan(result, validateWrite);
      }
      catch (error) {
        const cleanupErrors: string[] = [];
        await Promise.resolve(context.workspaceState.update(backupKey, previousBackup)).catch(failure => cleanupErrors.push(errorMessage(failure)));
        await Promise.resolve(context.globalState.update(pendingKey, undefined)).catch(failure => cleanupErrors.push(errorMessage(failure)));
        recoveryCheckpoint = previousCheckpoint;
        if (cleanupErrors.length) throw new Error(`${errorMessage(error)} Recovery storage cleanup also failed: ${cleanupErrors.join('; ')}`);
        throw error;
      }
      let recoveryWarning: string | undefined;
      try {
        await context.globalState.update(savedKey, proposedCheckpoint);
        recoveryCheckpoint = proposedCheckpoint;
        await context.globalState.update(pendingKey, undefined);
      } catch (error) { recoveryWarning = `Settings were applied, but recovery storage could not be finalized: ${errorMessage(error)}`; }
      current.dirty = false;
      const appliedPreset = selectedPreset;
      const appliedOptions = presetOptions;
      await load(current.root);
      selectedPreset = appliedPreset; presetOptions = appliedOptions;
      if (recoveryWarning && currentState) currentState.warnings.push(recoveryWarning);
      vscode.window.showInformationMessage('AgentScope: Settings saved. Start a new Codex session to load its scope; saved configuration does not confirm runtime activation.');
    } finally { finishWriting(); }
  }

  async function restore(): Promise<void> {
    trusted();
    const root = currentState?.root ?? selectedWorkspaceRoot;
    if (!root) throw new Error('Select a workspace before restoring its configuration.');
    ensureWorkspaceOpen(root);
    await assertWorkspaceLocation(root);
    const previous = undoBackup(root, context.workspaceState.get(`backup:${root}`));
    const result = { changes: previous, warnings: [] };
    const rootIdentity = currentState?.rootIdentity ?? await captureDirectoryIdentity(root);
    assertSavedDocuments(result);
    writing = true; update();
    try {
      const action = await vscode.window.showWarningMessage('Restore the configuration from before the last AgentScope apply?',
        { modal: true, detail: 'Restoration stops if those files have since changed.' }, 'Restore');
      if (action !== 'Restore') { return; }
      ensureWorkspaceOpen(root);
      assertSavedDocuments(result);
      await restoreChanges(previous, async () => {
        await assertWorkspaceLocation(root);
        await assertDirectoryIdentity(root, rootIdentity);
        ensureWorkspaceOpen(root); assertSavedDocuments(result);
        if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before restoring its configuration.');
      });
      await context.workspaceState.update(`backup:${root}`, undefined);
      await load(root);
      vscode.window.showInformationMessage('AgentScope: Previous configuration restored.');
    } finally { finishWriting(); }
  }

  async function recover(): Promise<void> {
    trusted();
    const root = currentState?.root ?? selectedWorkspaceRoot;
    if (!root) throw new Error('Select a workspace before recovering its saved configuration.');
    ensureWorkspaceOpen(root);
    await assertWorkspaceLocation(root);
    const saved = validateCheckpoint(context.globalState.get(checkpointKey(root)), root);
    writing = true; update();
    try {
      const result = await buildPolicyRecoveryPlan(root, saved);
      ensureWorkspaceOpen(root);
      const validateRecovery = async () => {
        ensureWorkspaceOpen(root);
        await assertWorkspaceLocation(root);
        assertSavedDocuments(result);
        if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before recovering its configuration.');
      };
      const unsaved = vscode.workspace.textDocuments.find(document => document.isDirty && document.uri.scheme === 'file' &&
        [...result.changes, ...(result.checks ?? [])].some(input => sameConfigurationPath(input.path, document.uri.fsPath)));
      if (unsaved) throw new Error('Save or discard unsaved policy edits before recovering the saved configuration.');
      if (!result.changes.length) {
        await applyPlan(result, validateRecovery);
        await load(root);
        vscode.window.showInformationMessage('AgentScope: Saved policy configuration is already on disk; no files changed.');
        return;
      }
      if (result.changes.length) {
        const backupKey = `backup:${root}`;
        const previousBackup = context.workspaceState.get<FileChange[]>(backupKey);
        await context.workspaceState.update(backupKey, result.changes);
        try { await applyPlan(result, validateRecovery); }
        catch (error) {
          await Promise.resolve(context.workspaceState.update(backupKey, previousBackup)).catch(() => undefined);
          throw error;
        }
      }
      if (currentState) currentState.dirty = false;
      await load(root);
      vscode.window.showInformationMessage('AgentScope: Saved policy configuration recovered. Restore last apply can undo this recovery.');
    } finally { finishWriting(); }
  }

  async function reconfigure(): Promise<void> {
    trusted();
    const root = currentState?.root ?? selectedWorkspaceRoot;
    if (!root) throw new Error('Select a workspace before configuring its access.');
    ensureWorkspaceOpen(root);
    selectingPaths = true; update();
    try {
      const registrations = recoveryCheckpoint ? readScopeConfiguration(recoveryCheckpoint.configuration, root) : undefined;
      const fresh = await loadWorkspaceForReconfiguration(root, registrations);
      ensureWorkspaceOpen(root);
      currentState = fresh; selectedWorkspaceRoot = fresh.root;
      await refreshWorkspaceSelectionRoots(fresh);
      configurationError = null; selectedPreset = null; presetOptions = undefined;
      workspaceUnavailable = false;
      workspaceId++;
      watchConfiguration(fresh.root);
    } finally { finishPathSelection(); }
  }

  async function sharedPaths(): Promise<void> {
    trusted();
    selectingPaths = true; update();
    try { await editSharedPaths(); }
    finally { finishPathSelection(); }
  }

  async function editSharedPaths(): Promise<void> {
    const current = state();
    if (!hasWorkspaceResources()) { throw new Error('Use the workspace root project to manage its files; its scope already covers workspace resources.'); }
    const choice = await vscode.window.showQuickPick([
      { label: 'Add read file', access: 'read' as const, directory: false },
      { label: 'Add read folder', access: 'read' as const, directory: true },
      { label: 'Add write file', access: 'write' as const, directory: false },
      { label: 'Add write folder', access: 'write' as const, directory: true },
      { label: 'Remove read path', access: 'read' as const, remove: true },
      { label: 'Remove write path', access: 'write' as const, remove: true },
    ], { title: 'AgentScope: Workspace resources' });
    if (!choice) return;
    if ('remove' in choice) {
      const field = choice.access === 'read' ? 'read_paths' : 'write_paths';
      const selected = await vscode.window.showQuickPick(current.registry.shared_resources[field], { title: choice.label });
      if (selected !== undefined) {
        const candidate = await toggleResourceSelection(current.root, current.registry, selected, choice.access, false, true);
        if (currentState !== current) { throw new Error('The workspace changed while choosing a resource. Try again.'); }
        current.registry.shared_resources = candidate; draft();
      }
      return;
    }
    const selected = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(current.root),
      canSelectFiles: !choice.directory, canSelectFolders: choice.directory, canSelectMany: false, openLabel: 'Allow workspace path' });
    if (!selected?.length) { return; }
    const relative = normalizeRelative(path.relative(current.root, selected[0].fsPath));
    const candidate = await toggleResourceSelection(current.root, current.registry, relative, choice.access, true, choice.directory);
    if (currentState !== current) { throw new Error('The workspace changed while choosing a resource. Try again.'); }
    current.registry.shared_resources = candidate;
    draft();
  }

  async function resourceVisibility(relative: string): Promise<void> {
    trusted();
    const current = state();
    if (!hasWorkspaceResources() || !isResourcePath(current.registry, relative)) { throw new Error('Choose a workspace file or folder outside the registered projects.'); }
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.';
    const entries = await listWorkspaceChildren(current.root, current.registry, parent);
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const entry = entries.find(child => key(child.relative) === key(relative));
    if (!entry?.selectable) { throw new Error('The workspace path changed. Refresh before changing visibility.'); }
    if (currentState !== current) { throw new Error('The workspace changed during path selection. Try again.'); }
    current.resourceHidden ??= Object.create(null) as Record<string, boolean>;
    current.resourceVisibilityChanges ??= Object.create(null) as Record<string, boolean>;
    current.resourceHidden[relative] = !current.resourceHidden[relative];
    current.resourceVisibilityChanges[relative] = current.resourceHidden[relative];
    draft();
  }

  async function savePreset(updateExisting = false): Promise<void> {
    trusted();
    const current = state();
    assertPresetSaved(current.root);
    writing = true; update();
    try {
      await ensureWritableWorkspace(current);
      const existing = await readPresetsSnapshot(current.root);
      let name: string | undefined;
      if (updateExisting) {
        const names = Object.keys(existing.store.presets).sort();
        if (!names.length) throw new Error('No saved presets. Use Save preset first.');
        name = await vscode.window.showQuickPick(names, { title: 'AgentScope: Update preset',
          placeHolder: 'Replace this preset with the current access and visibility draft.' });
      } else {
        name = await vscode.window.showInputBox({ title: 'AgentScope: Save preset', prompt: 'Name this access and visibility configuration.',
          value: selectedPreset ?? '', validateInput: value => {
            try { validatePresetName(value.trim()); return undefined; }
            catch (error) { return errorMessage(error); }
          } });
      }
      if (!name?.trim()) return;
      await ensureWritableWorkspace(current);
      if (updateExisting && !Object.hasOwn(existing.store.presets, name.trim())) throw new Error('The selected preset no longer exists. Choose it again.');
      if (Object.hasOwn(existing.store.presets, name.trim())) {
        const replace = await vscode.window.showWarningMessage(`Replace preset “${name.trim()}”?`, { modal: true }, 'Replace');
        if (replace !== 'Replace') return;
      }
      const snapshot: ScopePreset = structuredClone({ registry: current.registry, hidden: current.hidden,
        resourceHidden: current.resourceHidden ?? {}, options: effectiveOptions() });
      await validatePresetWrite(current);
      await writePreset(current.root, name.trim(), snapshot, () => validatePresetWrite(current), existing.text);
      if (current.files) delete current.files[resolveContained(current.root, '.vscode/agentscope-presets.json')];
      selectedPreset = name.trim();
      current.dirty = true;
      vscode.window.showInformationMessage(`AgentScope: Preset “${selectedPreset}” ${updateExisting ? 'updated' : 'saved'}. Apply publishes its permissions.`);
    } finally { finishWriting(); }
  }

  async function activatePreset(): Promise<void> {
    trusted();
    const current = state();
    assertPresetSaved(current.root);
    let activate = false;
    writing = true; update();
    try {
      await ensureWritableWorkspace(current);
      const snapshot = await readPresetsSnapshot(current.root);
      const store = snapshot.store;
      const names = Object.keys(store.presets).sort();
      if (!names.length) throw new Error('No saved presets. Use Save preset first.');
      const name = await vscode.window.showQuickPick(names, { title: 'AgentScope: Activate preset', placeHolder: 'Review and apply the selected saved configuration.' });
      if (!name) return;
      await ensureWritableWorkspace(current);
      if (current.dirty) {
        const replace = await vscode.window.showWarningMessage('Replace the current unapplied draft with this preset?', { modal: true }, 'Load preset');
        if (replace !== 'Load preset') return;
      }
      await ensureWritableWorkspace(current);
      assertPresetSaved(current.root);
      if ((await readPresetsSnapshot(current.root)).text !== snapshot.text) {
        throw new Error('Saved presets changed while choosing settings. Refresh and try again.');
      }
      const saved = structuredClone(store.presets[name]);
      if (!saved) throw new Error('The selected preset no longer exists. Choose it again.');
      for (const module of Object.values(saved.registry.submodules)) module.instruction_file = null;
      // Newly registered projects stay disabled until the user deliberately includes them in a preset.
      for (const [projectName, module] of Object.entries(current.registry.submodules)) {
        if (!Object.hasOwn(saved.registry.submodules, projectName)) {
          saved.registry.submodules[projectName] = { ...module, enabled: false, restrict_paths: true, read_paths: [], write_paths: [], instruction_file: null };
        } else if (normalizeRelative(saved.registry.submodules[projectName].path) !== normalizeRelative(module.path)) {
          throw new Error(`Preset project path changed for ${projectName}. Update the preset before activating it.`);
        }
      }
      validateRegistry(saved.registry, current.root);
      const resourceHidden: Record<string, boolean> = Object.create(null);
      for (const relative of new Set([...Object.keys(current.resourceHidden ?? {}), ...Object.keys(saved.resourceHidden)])) {
        if (!isResourcePath(saved.registry, relative)) {
          if (Object.hasOwn(saved.resourceHidden, relative)) throw new Error(`Preset resource visibility overlaps a registered project: ${relative}`);
          continue;
        }
        resourceHidden[relative] = saved.resourceHidden[relative] === true;
      }
      current.files ??= {};
      current.files[resolveContained(current.root, '.vscode/agentscope-presets.json')] = snapshot.text;
      current.registry = saved.registry;
      current.hidden = Object.fromEntries(Object.keys(saved.registry.submodules).map(projectName => [projectName, saved.hidden[projectName] === true]));
      current.resourceHidden = resourceHidden;
      current.resourceVisibilityChanges = { ...resourceHidden };
      current.dirty = true; selectedPreset = name; presetOptions = saved.options;
      await refreshWorkspaceSelectionRoots(current);
      activate = true;
    } finally { finishWriting(); }
    if (activate) await apply();
  }

  async function removePreset(): Promise<void> {
    trusted();
    const current = state();
    assertPresetSaved(current.root);
    writing = true; update();
    try {
      await ensureWritableWorkspace(current);
      const snapshot = await readPresetsSnapshot(current.root);
      const name = await vscode.window.showQuickPick(Object.keys(snapshot.store.presets).sort(), { title: 'AgentScope: Delete preset' });
      if (!name) return;
      if (!Object.hasOwn(snapshot.store.presets, name)) throw new Error('The selected preset no longer exists. Choose it again.');
      const confirmed = await vscode.window.showWarningMessage(`Delete preset “${name}”?`, { modal: true }, 'Delete');
      if (confirmed !== 'Delete') return;
      await validatePresetWrite(current);
      await deletePreset(current.root, name, () => validatePresetWrite(current), snapshot.text);
      if (current.files) delete current.files[resolveContained(current.root, '.vscode/agentscope-presets.json')];
      if (selectedPreset === name) selectedPreset = null;
      current.dirty = true;
      vscode.window.showInformationMessage(`AgentScope: Preset “${name}” deleted.`);
    } finally { finishWriting(); }
  }

  async function toggleNewChatPresetPrompt(): Promise<void> {
    trusted();
    const current = state();
    const config = vscode.workspace.getConfiguration('agentscope', vscode.Uri.file(current.root));
    await ensureWritableWorkspace(current);
    await config.update('promptPresetForNewChat', !config.get<boolean>('promptPresetForNewChat', false), vscode.ConfigurationTarget.WorkspaceFolder);
    update();
  }

  async function newChat(): Promise<void> {
    trusted();
    const current = state();
    startingChat = true; update();
    try {
    // The public Codex command ignores profile arguments. Never change a global
    // default and claim that the new conversation was bound to that profile.
    let prepared: ApplyPlan;
    selectingPaths = true; update();
    try { prepared = await plan(); }
    finally { finishPathSelection(); }
    const options = resolvedOptions();
    const targetRoot = runtimeWorkspaceRoot(current.root, options.codexRuntime, options.codexWorkspaceRoot);
    const nativeWindows = (root: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(root);
    const profiles = (prepared.exportedProfiles ?? []).filter(profile => !profile.runtimeRoot || nativeWindows(profile.runtimeRoot) === nativeWindows(targetRoot));
    if (!profiles.length) throw new Error('Save a preset with Codex profile generation enabled for the current native/WSL runtime before starting a scoped chat.');
    let chosen: { name: string; profileName: string } | undefined;
    let verifiedPlan: ApplyPlan | undefined;
    await chooseAndOpenScopedChat(profiles.map(profile => ({ name: profile.presetName, profileName: profile.profileName })), {
      choose: async entries => {
        selectingPaths = true; update();
        try {
          const selected = await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.name,
            description: profiles.find(profile => profile.profileName === entry.profileName)?.description, entry })), {
            title: 'AgentScope: Preset for new Codex chat', placeHolder: 'Select the matching entry in Codex Permissions before sending your first message.',
          });
          ensureWorkspace(current); chosen = selected?.entry; return chosen;
        } finally { finishPathSelection(); }
      },
      publish: async () => {
        ensureWorkspace(current);
        const latest = await plan();
        // Validate the captured inputs before offering to publish them. Planning
        // deliberately parses the original bytes and must not adopt later edits.
        await applyPlan({ ...latest, changes: [], checks: [
          ...(latest.checks ?? []), ...latest.changes.map(change => ({ path: change.path, expected: change.before })),
        ] }, () => ensureWritableWorkspace(current));
        if (!latest.exportedProfiles?.some(profile => profile.profileName === chosen?.profileName)) throw new Error('The chosen preset changed. Choose it again.');
        if (latest.changes.length) await apply(true);
        const verified = await plan();
        if (verified.changes.length) {
          throw new Error('Apply the exported permission profiles before starting this chat.');
        }
        if (!verified.exportedProfiles?.some(profile => profile.profileName === chosen?.profileName)) throw new Error('The chosen preset changed. Choose it again.');
        verifiedPlan = verified;
      },
      open: async () => {
        if (!verifiedPlan) throw new Error('Verify the chosen preset before opening a chat.');
        await applyPlan(verifiedPlan, async () => {
          if (!sameConfigurationPath(state().root, current.root)) throw new Error('The selected workspace changed. Choose the preset again.');
          await ensureWritableWorkspace(state()); assertSavedDocuments(verifiedPlan!);
        });
        await vscode.commands.executeCommand('chatgpt.newChat');
      },
      guide: async entry => {
        const profile = profiles.find(item => item.profileName === entry.profileName)!;
        void vscode.window.showInformationMessage(`AgentScope: Use workspace “${current.root}” (Codex path: “${profile.runtimeRoot || targetRoot}”) in Codex and, before sending, select “${profile.description}” in Permissions. Codex's public new-chat command cannot select the workspace or profile automatically; its current remembered choice may differ. After moving a folder, reopen its current location, trust the project in Codex when prompted, Apply, and start a new chat.`);
      },
    });
    } finally { startingChat = false; update(); drainDeferredChanges(); }
  }

  async function refresh(): Promise<void> {
    if (selectingPaths || writing || loading || startingChat) { throw new Error('Wait for the current configuration operation before refreshing.'); }
    if (currentState?.dirty) {
      const discard = await vscode.window.showWarningMessage('Discard the pending AgentScope draft and reload configuration?', 'Discard draft');
      if (discard !== 'Discard draft') { return; }
    }
    await load(currentState?.root ?? selectedWorkspaceRoot);
  }

  async function selectWorkspace(): Promise<void> {
    if (selectingPaths || writing || loading || startingChat) { throw new Error('Wait for the current configuration operation before switching workspaces.'); }
    if (currentState?.dirty) {
      const discard = await vscode.window.showWarningMessage('Discard the current draft before switching workspace folders?', 'Discard draft');
      if (discard !== 'Discard draft') { return; }
    }
    const selected = await pickWorkspace(true);
    if (selected) { await load(selected); }
  }

  async function openWorkspaceFolder(): Promise<void> {
    if (selectingPaths || writing || loading || startingChat) throw new Error('Wait for the current configuration operation before opening another workspace.');
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      title: 'AgentScope: Open the workspace at its current location', openLabel: 'Open folder' });
    const folder = folders?.[0];
    if (!folder) return;
    if (folder.scheme !== 'file') throw new Error('Select a local workspace folder.');
    await assertWorkspaceLocation(folder.fsPath);
    // Keep the old window and any pending draft intact; the new window selects
    // the current folder through VS Code's public workspace command.
    await vscode.commands.executeCommand('vscode.openFolder', folder, true);
  }

  async function guarded(action: () => Promise<unknown>, notify = true): Promise<void> {
    try { await action(); }
    catch (error) {
      if (error instanceof WorkspaceLocationError && selectedWorkspaceRoot &&
        (sameConfigurationPath(error.root, selectedWorkspaceRoot) || !!selectedWorkspaceFolderPath && sameConfigurationPath(error.root, selectedWorkspaceFolderPath)) &&
        (!workspaceUnavailable || currentState)) {
        currentState = undefined; workspaceSelectionRoots = []; recoveryCheckpoint = undefined;
        selectedPreset = null; presetOptions = undefined;
        configurationError = error.message; workspaceUnavailable = true; workspaceId++;
      }
      if (notify) void vscode.window.showErrorMessage(`AgentScope: ${errorMessage(error)}`);
      update();
    }
  }

  function receiveMessage(value: unknown): Promise<void> {
    messageQueue = messageQueue.then(() => guarded(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid scope panel message.'); }
      const message = value as Record<string, unknown>;
      if (message.type === 'ready') { update(); return; }
      if (!Number.isSafeInteger(message.workspaceId) || message.workspaceId !== workspaceId) {
        throw new Error('The workspace changed. Refresh the panel before selecting access.');
      }
      if (loading) { throw new Error('Wait for the workspace to finish loading.'); }
      if (!currentState) {
        const recoveryCommand = typeof message.command === 'string' ? message.command : undefined;
        const recovery = recoveryCommand === 'refresh' || recoveryCommand === 'selectWorkspace' || recoveryCommand === 'openWorkspaceFolder' ||
          (selectedWorkspaceRoot && recoveryCommand && ['openConfiguration', 'openCodex', 'restore', 'recover', 'reconfigure'].includes(recoveryCommand));
        if (message.type === 'command' && message.name === undefined && message.target === undefined && recoveryCommand && recovery) {
          await actions[recoveryCommand](); update(); return;
        }
        if (configurationError) throw new Error('Fix the workspace configuration error before selecting access or applying changes.');
        throw new Error('The workspace changed. Refresh the panel before selecting access.');
      }
      const current = state();
      if (message.target !== undefined && message.target !== 'project' && message.target !== 'resource') { throw new Error('Invalid scope target.'); }
      if (message.type === 'command') {
        if (message.command === 'toggleResourceVisibility') {
          if (message.target !== 'resource' || typeof message.relative !== 'string') { throw new Error('A workspace resource path is required.'); }
          await resourceVisibility(normalizeRelative(message.relative)); return;
        }
        if (message.target === 'resource') { throw new Error('Use a workspace resource action for this target.'); }
        const allowed = ['refresh', 'apply', 'preview', 'addFolder', 'selectWorkspace', 'openWorkspaceFolder', 'configure',
          'toggleVisibility', 'toggleAccess', 'sharedPaths', 'restore', 'recover', 'reconfigure', 'openConfiguration', 'openCodex', 'removeProject', 'savePreset', 'updatePreset', 'activatePreset', 'deletePreset', 'newChat', 'toggleNewChatPresetPrompt'];
        if (typeof message.command !== 'string' || !allowed.includes(message.command)) {
          throw new Error('Unknown scope panel command.');
        }
        if (message.name !== undefined && (typeof message.name !== 'string' || !Object.hasOwn(current.registry.submodules, message.name))) {
          throw new Error('The project changed. Refresh the panel before editing its settings.');
        }
        const node = typeof message.name === 'string' ? { kind: 'module' as const, name: message.name } : undefined;
        await actions[message.command](node);
        update(); return;
      }
      if (message.type !== 'children' && message.type !== 'toggle') { throw new Error('Invalid scope panel message.'); }
      if (message.target === 'resource') {
        if (!hasWorkspaceResources() || message.name !== '@workspace' || typeof message.relative !== 'string') { throw new Error('A workspace resource path is required.'); }
        const relative = normalizeRelative(message.relative);
        if (message.type === 'children') {
          if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) < 0) { throw new Error('Invalid folder request.'); }
          const response = { type: 'children', target: 'resource', workspaceId, name: '@workspace', relative, requestId: message.requestId };
          try {
            const entries = await listWorkspaceChildren(current.root, current.registry, relative);
            if (currentState !== current) return;
            const selection = selectionReader(resourceScope(current.registry));
            await view.send({ ...response, rows: entries.map(entry => workspaceResourceRow(entry.relative, entry.directory, entry.selectable, entry.symbolicLink, selection(entry.relative))) });
          } catch (error) { await view.send({ ...response, rows: [], error: errorMessage(error) }); }
          return;
        }
        trusted();
        if ((message.access !== 'read' && message.access !== 'write') || typeof message.checked !== 'boolean' || typeof message.directory !== 'boolean') {
          throw new Error('Invalid permission checkbox selection.');
        }
        selectingPaths = true; update();
        try {
          if (relative === '.' && !message.directory) throw new Error('Workspace files is a folder selection.');
          const next = relative === '.'
            ? await toggleWorkspaceSelection(current.root, current.registry, message.access, message.checked)
            : await toggleResourceSelection(current.root, current.registry, relative, message.access, message.checked, message.directory);
          if (currentState !== current) { throw new Error('The workspace changed during path selection. Select the path again.'); }
          current.registry.shared_resources = next; current.dirty = true; selectedPreset = null;
          await refreshWorkspaceSelectionRoots(current);
        } finally { finishPathSelection(); }
        return;
      }
      if (typeof message.name !== 'string' || !Object.hasOwn(current.registry.submodules, message.name)) {
        throw new Error('The project changed. Refresh the panel before selecting its paths.');
      }
      if (typeof message.relative !== 'string') { throw new Error('A literal relative project path is required.'); }
      const relative = normalizeRelative(message.relative);
      const name = message.name;
      const module = current.registry.submodules[name];
      if (message.type === 'children') {
        if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) < 0) {
          throw new Error('Invalid folder request.');
        }
        const response = { type: 'children', workspaceId, name, relative, requestId: message.requestId };
        try {
          const entries = await listProjectChildren(current.root, module.path, relative);
          if (currentState !== current) { return; }
          const selection = selectionReader(module);
          await view.send({ ...response, rows: entries.map(entry => permissionRow(name, entry.relative, entry.directory, false, entry.symbolicLink, selection(entry.relative))) });
        } catch (error) { await view.send({ ...response, rows: [], error: errorMessage(error) }); }
        return;
      }
      trusted();
      if ((message.access !== 'read' && message.access !== 'write') || typeof message.checked !== 'boolean' || typeof message.directory !== 'boolean') {
        throw new Error('Invalid permission checkbox selection.');
      }
      if (relative === '.' && !message.directory) { throw new Error('The project root is a folder.'); }
      selectingPaths = true; update();
      try {
        let checkedEntry: SelectionChild | undefined;
        if (message.checked && relative !== '.') {
          checkedEntry = await inspectProjectEntry(current.root, module.path, relative);
          if (checkedEntry.directory !== message.directory) {
            throw new Error('This file or folder changed since it was displayed. Refresh before selecting access.');
          }
        }
        const next = await togglePathSelection(module, relative, message.access as AccessKind, message.checked,
          (directory, options) => checkedEntry ? Promise.resolve([checkedEntry]) : listProjectChildren(current.root, module.path, directory, options));
        if (currentState !== current) { throw new Error('The workspace changed during path selection. Select the path again.'); }
        current.registry.submodules[name] = next;
        current.dirty = true; selectedPreset = null;
      } finally { finishPathSelection(); }
    }));
    return messageQueue;
  }

  async function openConfiguration(relative: string): Promise<unknown> {
    const selected = currentState?.root ?? selectedWorkspaceRoot;
    if (!selected) throw new Error('Open and select a local workspace folder first.');
    const root = await verifyContained(selected, selected);
    const target = resolveContained(root, relative);
    const canonical = await verifyContained(root, target);
    const comparePath = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparePath(canonical) !== comparePath(target)) throw new Error(`Refusing a symbolic link or junction in a configuration path: ${relative}`);
    return vscode.window.showTextDocument(vscode.Uri.file(target));
  }

  async function changeProject(node: ScopeNode | undefined, change: (current: WorkspaceState, name: string) => void,
    refreshResources = false): Promise<void> {
    trusted();
    const current = state();
    selectingPaths = true; update();
    try {
      const name = await moduleName(node);
      ensureWorkspace(current);
      if (!name) return;
      if (!Object.hasOwn(current.registry.submodules, name)) throw new Error('This project is not registered in the selected workspace.');
      change(current, name); draft();
      if (refreshResources) await refreshWorkspaceSelectionRoots(current);
    } finally { finishPathSelection(); }
  }

  const actions: Record<string, (...args: any[]) => Promise<unknown>> = {
    refresh, selectWorkspace, openWorkspaceFolder, addFolder, configure, preview: () => preview(), apply, restore, recover, reconfigure, sharedPaths,
    savePreset: () => savePreset(), updatePreset: () => savePreset(true), activatePreset, deletePreset: removePreset, newChat, toggleNewChatPresetPrompt,
    toggleVisibility: (node?: ScopeNode) => changeProject(node, (current, name) => {
      if (current.registry.submodules[name].path === '.') throw new Error('The open workspace root cannot be hidden. Manage visibility for its child projects instead.');
      current.hidden[name] = !current.hidden[name];
    }),
    toggleAccess: (node?: ScopeNode) => changeProject(node, (current, name) => {
      current.registry.submodules[name].enabled = !current.registry.submodules[name].enabled;
    }),
    openConfiguration: () => openConfiguration(SCOPE_CONFIGURATION_FILE),
    openCodex: () => openConfiguration('.codex/config.toml'),
    removeProject: (node?: ScopeNode) => changeProject(node, (current, name) => {
      delete current.registry.submodules[name]; delete current.hidden[name];
      workspaceId++;
    }, true),
  };
  for (const [name, action] of Object.entries(actions)) {
    context.subscriptions.push(vscode.commands.registerCommand(`agentscope.${name}`, (...args) => guarded(() => action(...args))));
  }
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    queuedWorkspaceReconciliation = true;
    drainDeferredChanges();
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(update));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!currentState) return;
    const resource = vscode.Uri.file(currentState.root);
    if (event.affectsConfiguration('agentscope', resource) ||
      event.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux', resource)) {
      currentState.dirty = true;
      update();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => { previews.documents.delete(document.uri.toString()); }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agentscope-preview', previews), previews, view, status,
    { dispose: () => { disposed = true; queuedReloadRoot = undefined; for (const watcher of watchers) { watcher.dispose(); } } });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('agentscope.projects', view));
  const initialFolders = vscode.workspace.workspaceFolders ?? [];
  if (initialFolders.length === 1 && initialFolders[0].uri.scheme === 'file') {
    void guarded(() => load(initialFolders[0].uri.fsPath), false);
  } else { update(); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sameConfigurationPath(first: string, second: string): boolean {
  const left = path.resolve(first); const right = path.resolve(second);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function undoBackup(root: string, value: unknown): FileChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('No valid Restore backup is available for this workspace.');
  const key = (target: string) => process.platform === 'win32' ? target.toLowerCase() : target;
  const allowed = new Set(['AGENTS.md', ACCESS_POLICY_FILE, SCOPE_CONFIGURATION_FILE, '.vscode/settings.json', '.codex/config.toml'].map(relative => key(resolveContained(root, relative))));
  const seen = new Set<string>();
  return value.map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).length !== 3 ||
      !['path', 'before', 'after'].every(field => Object.hasOwn(change, field)) || typeof change.path !== 'string' ||
      !path.isAbsolute(change.path) || change.path !== path.resolve(change.path) || !allowed.has(key(change.path)) ||
      seen.has(key(change.path)) || (change.before !== null && typeof change.before !== 'string') || typeof change.after !== 'string') {
      throw new Error('Invalid Restore backup: expected unique configuration files belonging to this workspace.');
    }
    seen.add(key(change.path));
    return { path: change.path, before: change.before, after: change.after };
  });
}
