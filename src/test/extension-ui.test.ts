import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module = require('node:module');
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as TOML from '@iarna/toml';
import { parseJsoncStrict, writeAccessFiles } from '../core/registry';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from '../configuration';
import { checkpointKey, validateCheckpoint } from '../recovery';
import type { ModuleConfig } from '../types';
import type { PermissionRow, ScopeViewModel } from '../scopeView';
import { fixture, policy, project, registry } from './helpers';

interface Disposable { dispose(): void }
class MockUri {
  constructor(readonly scheme: string, readonly fsPath: string, private readonly value: string) {}
  static file(filename: string): MockUri { return new MockUri('file', filename, `file://${filename.replace(/\\/g, '/')}`); }
  static parse(value: string): MockUri { return new MockUri(value.split(':')[0], '', value); }
  static joinPath(base: MockUri, ...segments: string[]): MockUri { return MockUri.file(path.join(base.fsPath, ...segments)); }
  toString(): string { return this.value; }
}

interface ChildrenResponse {
  type: 'children'; workspaceId: number; name: string; relative: string; requestId: number;
  target?: 'resource';
  rows: PermissionRow[]; error?: string;
}

interface PersistenceOptions {
  multiRoot?: boolean;
  leaveWorkspaceUnselected?: boolean;
  failCheckpointSave?: boolean;
  initialCheckpoint?: (root: string) => unknown;
  initialPending?: (root: string) => unknown;
  initialBackup?: (root: string) => unknown;
}

/** Mock only VS Code's host boundary; the bridge, browsing, storage and writes are real. */
async function activateInFixture(t: TestContext, isTrusted = true, failBackupSave = false, moduleOverrides: Partial<ModuleConfig> = {},
  prepare?: (root: string) => Promise<void>, persistence: PersistenceOptions = {}) {
  const { root } = await fixture(t);
  for (const folder of ['project/references/nested', 'project/drafts', 'Instructions', '.vscode', '.codex']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await Promise.all([
    fs.writeFile(path.join(root, 'project', 'references', 'nested', 'paper.md'), 'Selected reference\n', 'utf8'),
    fs.writeFile(path.join(root, 'project', 'references', 'nested', 'sibling.md'), 'Unselected reference\n', 'utf8'),
    fs.writeFile(path.join(root, 'Instructions', 'guide.md'), 'Workflow guide\n', 'utf8'),
    fs.writeFile(path.join(root, 'Instructions', 'other.md'), 'Other workflow\n', 'utf8'),
    fs.writeFile(path.join(root, 'README.md'), 'Workspace overview\n', 'utf8'),
  ]);
  const initialRegistry = registry({ project: project({ enabled: false, ...moduleOverrides }) });
  if (moduleOverrides.path === '.') initialRegistry.shared_resources = { read_paths: [], write_paths: [] };
  const originals = new Map<string, string>([
    ['AGENTS.md', policy(initialRegistry)],
    ['.vscode/settings.json', '{\n  // Keep editor settings\n  "editor.tabSize": 4,\n  "files.exclude": { "**/.cache": true }\n}\n'],
    ['.codex/config.toml', '# Keep my configuration\nmodel = "example-model"\n[features]\nexample = true\n'],
  ]);
  for (const [file, contents] of originals) { await fs.writeFile(path.join(root, file), contents, 'utf8'); }
  await prepare?.(root);

  const errors: string[] = [];
  const confirmations: string[] = [];
  const confirmationDetails: string[] = [];
  const applyAnswers: Array<string | undefined> = [];
  const informationMessages: string[] = [];
  const inputAnswers: string[] = [];
  const quickAnswers: unknown[] = [];
  const quickPickPrompts: Array<{ items: unknown; options: any }> = [];
  const previewProviders = new Map<string, { provideTextDocumentContent(uri: MockUri): string }>();
  const executeCalls: Array<{ name: string; args: unknown[] }> = [];
  const closedDocumentListeners = new Set<(document: { uri: MockUri }) => unknown>();
  const warningAnswers: string[] = [];
  const beforeApplyConfirmation: Array<() => Promise<void>> = [];
  const beforeRestoreConfirmation: Array<() => Promise<void>> = [];
  const beforePresetInput: Array<() => Promise<void>> = [];
  const beforePresetConfirmation: Array<() => Promise<void>> = [];
  const beforeBackupSave: Array<() => Promise<void>> = [];
  const openAnswers: unknown[] = [];
  const workspaceFolderListeners = new Set<() => void>();
  const configurationListeners = new Set<(event: { affectsConfiguration(section: string, resource?: MockUri): boolean }) => unknown>();
  const configuration: Record<string, unknown> = {};
  const chatgptConfiguration: Record<string, unknown> = {};
  const textDocuments: Array<{ isDirty: boolean; uri: MockUri; fileName: string }> = [];
  const watcherPatterns: string[] = [];
  type FileEvent = 'change' | 'create' | 'delete';
  const fileWatchers: Array<{
    pattern: string; disposed: boolean; listeners: Record<FileEvent, Set<(uri: MockUri) => unknown>>;
  }> = [];
  const openedDocuments: MockUri[] = [];
  const loadGates: Array<{ started(): void; release: Promise<void> }> = [];
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
  const backups = new Map<string, unknown>();
  const durable = new Map<string, unknown>();
  const storageControl = { failCheckpointSave: persistence.failCheckpointSave === true, failPendingCleanup: false };
  if (persistence.initialCheckpoint) durable.set(checkpointKey(root), persistence.initialCheckpoint(root));
  if (persistence.initialPending) durable.set(`${checkpointKey(root)}.pending`, persistence.initialPending(root));
  if (persistence.initialBackup) backups.set(`backup:${root}`, persistence.initialBackup(root));
  const messages: any[] = [];
  const observers = new Set<(message: any) => void>();
  const receivers = new Set<(message: unknown) => unknown>();
  let provider: any;
  let latestState: ScopeViewModel | undefined;
  let requestId = 0;
  const disposable = (): Disposable => ({ dispose() {} });
  const webview: any = {
    html: '', options: {}, cspSource: 'vscode-webview://agentscope-test',
    asWebviewUri: (uri: MockUri) => MockUri.parse(`vscode-resource:${uri.fsPath.replace(/\\/g, '/')}`),
    onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
      receivers.add(listener); return { dispose: () => { receivers.delete(listener); } };
    },
    postMessage: async (message: unknown) => {
      // VS Code structured-clones the payload rather than retaining mutable draft references.
      const posted = structuredClone(message) as any;
      messages.push(posted);
      if (posted.type === 'state') { latestState = posted.state; }
      for (const observer of [...observers]) { observer(posted); }
      return true;
    },
  };
  const view: any = { webview, visible: true, onDidDispose: disposable, onDidChangeVisibility: disposable, show() {} };
  const host: any = {
    Uri: MockUri,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { WorkspaceFolder: 3 },
    RelativePattern: class { constructor(readonly base: string, readonly pattern: string) {} },
    window: {
      registerWebviewViewProvider: (id: string, value: unknown) => {
        assert.equal(id, 'agentscope.projects');
        assert.equal(provider, undefined, 'Register only one scope view');
        provider = value;
        return disposable();
      },
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: async (message: string, ...choices: unknown[]) => {
        informationMessages.push(message);
        if (choices.includes('Apply')) {
          confirmations.push(message);
          confirmationDetails.push((choices.find(choice => typeof choice === 'object' && choice !== null) as { detail?: string } | undefined)?.detail ?? '');
          await beforeApplyConfirmation.shift()?.();
          return applyAnswers.length ? applyAnswers.shift() : 'Apply';
        }
        return undefined;
      },
      showWarningMessage: async (_message: string, ...choices: unknown[]) => {
        if (choices.includes('Restore')) await beforeRestoreConfirmation.shift()?.();
        if (choices.includes('Replace') || choices.includes('Delete')) await beforePresetConfirmation.shift()?.();
        return warningAnswers.length ? warningAnswers.shift() :
          ['Restore', 'Recover', 'Reconfigure', 'Start fresh'].find(choice => choices.includes(choice));
      },
      showErrorMessage: async (message: string) => { errors.push(message); return undefined; },
      showQuickPick: async (items: unknown, options?: unknown) => {
        quickPickPrompts.push({ items, options });
        if (persistence.multiRoot && !quickAnswers.length && (options as { title?: string })?.title === 'AgentScope: Select workspace folder') {
          return (items as Array<{ folder: { uri: MockUri } }>).find(item => item.folder.uri.fsPath === root);
        }
        const answer = quickAnswers.shift();
        return typeof answer === 'function' ? answer(items, options) : answer;
      },
      showOpenDialog: async () => openAnswers.shift(),
      showInputBox: async () => {
        // Native input arrives after the host has published its queued busy state.
        await Promise.resolve();
        await beforePresetInput.shift()?.();
        return inputAnswers.shift();
      },
      showTextDocument: async (uri: MockUri) => { openedDocuments.push(uri); return undefined; },
    },
    workspace: {
      isTrusted,
      workspaceFolders: persistence.multiRoot ? [
        { name: 'Other workspace', uri: MockUri.file(path.join(path.dirname(root), 'other-workspace')), index: 0 },
        { name: path.basename(root), uri: MockUri.file(root), index: 1 },
      ] : [{ name: path.basename(root), uri: MockUri.file(root), index: 0 }],
      textDocuments,
      getConfiguration: (section: string, uri: MockUri) => {
        assert.ok(section === 'agentscope' || section === 'chatgpt'); assert.equal(uri.fsPath, root);
        const values = section === 'agentscope' ? configuration : chatgptConfiguration;
        return { get: (name: string, fallback: unknown) => Object.hasOwn(values, name) ? values[name] : fallback,
          update: async (name: string, value: unknown, target: number) => {
            assert.equal(target, host.ConfigurationTarget.WorkspaceFolder); values[name] = value;
          } };
      },
      createFileSystemWatcher: (pattern: { base: string; pattern: string }) => {
        assert.equal(pattern.base, root); watcherPatterns.push(pattern.pattern);
        const watcher = { pattern: pattern.pattern, disposed: false,
          listeners: { change: new Set<(uri: MockUri) => unknown>(), create: new Set<(uri: MockUri) => unknown>(), delete: new Set<(uri: MockUri) => unknown>() } };
        fileWatchers.push(watcher);
        const subscribe = (event: FileEvent, listener: (uri: MockUri) => unknown): Disposable => {
          assert.equal(watcher.disposed, false);
          watcher.listeners[event].add(listener);
          return { dispose: () => { watcher.listeners[event].delete(listener); } };
        };
        return {
          onDidChange: (listener: (uri: MockUri) => unknown) => subscribe('change', listener),
          onDidCreate: (listener: (uri: MockUri) => unknown) => subscribe('create', listener),
          onDidDelete: (listener: (uri: MockUri) => unknown) => subscribe('delete', listener),
          dispose() { watcher.disposed = true; for (const listeners of Object.values(watcher.listeners)) listeners.clear(); },
        };
      },
      onDidChangeWorkspaceFolders: (listener: () => void) => {
        workspaceFolderListeners.add(listener);
        return { dispose: () => { workspaceFolderListeners.delete(listener); } };
      },
      onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string, resource?: MockUri): boolean }) => unknown) => {
        configurationListeners.add(listener);
        return { dispose: () => { configurationListeners.delete(listener); } };
      },
      onDidGrantWorkspaceTrust: disposable,
      onDidCloseTextDocument: (listener: (document: { uri: MockUri }) => unknown) => {
        closedDocumentListeners.add(listener);
        return { dispose: () => { closedDocumentListeners.delete(listener); } };
      },
      registerTextDocumentContentProvider: (scheme: string, contentProvider: { provideTextDocumentContent(uri: MockUri): string }) => {
        previewProviders.set(scheme, contentProvider); return disposable();
      },
    },
    commands: {
      registerCommand: (name: string, callback: (...args: unknown[]) => Promise<void>) => {
        assert.ok(!commands.has(name), `Command registered twice: ${name}`);
        commands.set(name, callback); return { dispose: () => { commands.delete(name); } };
      },
      executeCommand: async (name: string, ...args: unknown[]) => {
        executeCalls.push({ name, args });
        await commands.get(name)?.(...args);
      },
    },
  };
  const context: any = {
    extensionUri: MockUri.file(path.resolve(__dirname, '../..')),
    subscriptions: [],
    globalState: {
      get: (key: string) => durable.get(key),
      update: async (key: string, value: unknown) => {
        if (storageControl.failCheckpointSave && value !== undefined) throw new Error('Simulated VS Code recovery-checkpoint storage failure');
        if (storageControl.failPendingCleanup && key.endsWith('.pending') && value === undefined) throw new Error('Simulated pending-checkpoint cleanup failure');
        if (value === undefined) durable.delete(key); else durable.set(key, structuredClone(value));
      },
    },
    workspaceState: {
      get: (key: string) => backups.get(key),
      update: async (key: string, value: unknown) => {
        if (failBackupSave && value !== undefined) { throw new Error('Simulated VS Code workspace-state storage failure'); }
        if (key.startsWith('backup:') && value !== undefined) await beforeBackupSave.shift()?.();
        if (value === undefined) { backups.delete(key); } else { backups.set(key, value); }
      },
    },
  };
  const waitForPosted = (predicate: (message: any) => boolean, label: string): Promise<any> => new Promise((resolve, reject) => {
    const observer = (message: any) => {
      if (!predicate(message)) { return; }
      clearTimeout(timer); observers.delete(observer); resolve(message);
    };
    const timer = setTimeout(() => {
      observers.delete(observer); reject(new Error(`${label} timed out: ${errors.join('; ')}`));
    }, 5000);
    observers.add(observer);
  });
  const emit = async (message: unknown): Promise<void> => {
    assert.ok(receivers.size, 'ScopeView must register its webview message listener');
    await Promise.all([...receivers].map(listener => Promise.resolve(listener(message))));
  };
  const state = (): ScopeViewModel => { assert.ok(latestState); return latestState; };
  const waitForState = (predicate: (model: ScopeViewModel) => boolean, label = 'File watcher refresh'): Promise<ScopeViewModel> => {
    if (latestState && predicate(latestState)) return Promise.resolve(latestState);
    return waitForPosted(posted => posted.type === 'state' && predicate(posted.state), label).then(posted => posted.state);
  };
  const activeWatcherPatterns = (): string[] => fileWatchers.filter(watcher => !watcher.disposed).map(watcher => watcher.pattern);
  const fireFileEvent = (relative: string, event: FileEvent = 'change'): void => {
    const matching = fileWatchers.filter(watcher => !watcher.disposed && watcher.pattern === relative);
    assert.equal(matching.length, 1, `Expected one active watcher for ${relative}`);
    const callbacks = [...matching[0].listeners[event]];
    assert.equal(callbacks.length, 1, `Expected one ${event} handler for ${relative}`);
    for (const listener of callbacks) listener(MockUri.file(path.join(root, relative)));
  };
  const emitFileEvent = async (relative: string, event: FileEvent = 'change'): Promise<void> => {
    const epoch = state().workspaceId;
    const refreshed = waitForState(model => model.workspaceId > epoch && !model.busy);
    fireFileEvent(relative, event);
    await refreshed;
    // Watcher callbacks intentionally return void; allow guarded error reporting
    // to settle after the state notification without using arbitrary sleeps.
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const pauseNextLoadedSnapshot = (): { started: Promise<void>; release(): void } => {
    let started!: () => void;
    let release!: () => void;
    const gate = { started: new Promise<void>(resolve => { started = resolve; }),
      release: new Promise<void>(resolve => { release = resolve; }) };
    loadGates.push({ started, release: gate.release });
    return { started: gate.started, release };
  };
  const dispatch = async (message: unknown): Promise<void> => {
    const refreshed = waitForPosted(posted => posted.type === 'state' && !posted.state.busy, 'Message handling');
    await emit(message);
    await refreshed;
  };
  const command = async (action: string, name?: string): Promise<void> => {
    await dispatch({ type: 'command', workspaceId: state().workspaceId, command: action, ...(name ? { name } : {}) });
  };
  const toggle = async (row: PermissionRow, access: 'read' | 'write', checked: boolean): Promise<void> => {
    await dispatch({ type: 'toggle', workspaceId: state().workspaceId, name: row.name, relative: row.relative,
      access, checked, directory: row.directory, ...(row.target === 'resource' ? { target: 'resource' } : {}) });
  };
  const children = async (relative = '.', target: 'project' | 'resource' = 'project', projectName = 'project'): Promise<PermissionRow[]> => {
    const id = ++requestId;
    const workspaceId = state().workspaceId;
    const response = waitForPosted(posted => posted.type === 'children' && posted.requestId === id, 'Children response');
    const name = target === 'resource' ? '@workspace' : projectName;
    await emit({ type: 'children', workspaceId, name, relative, requestId: id, ...(target === 'resource' ? { target } : {}) });
    const posted = await response as ChildrenResponse;
    assert.equal(posted.workspaceId, workspaceId); assert.equal(posted.name, name); assert.equal(posted.relative, relative);
    if (target === 'resource') assert.equal(posted.target, target);
    assert.equal(posted.error, undefined, posted.error);
    return posted.rows;
  };
  const projectRow = (): PermissionRow => {
    const row = state().projects.find(candidate => candidate.name === 'project' && candidate.project);
    assert.ok(row); return row;
  };
  const scope = (): ModuleConfig => { const module = projectRow().scope; assert.ok(module); return module; };
  const read = (file: string) => fs.readFile(path.join(root, file), 'utf8');

  const loader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const extensionPath = require.resolve('../extension');
  const viewPath = require.resolve('../scopeView');
  const startExtension = async (): Promise<void> => {
    delete require.cache[extensionPath]; delete require.cache[viewPath];
    loader._load = function (name, parent, isMain) {
      if (name === 'vscode') return host;
      const loaded = originalLoad.call(this, name, parent, isMain);
      if (name === './workspace' && (parent as { filename?: string })?.filename === extensionPath) {
        const workspace = loaded as typeof import('../workspace');
        return { ...workspace, loadWorkspace: async (...args: Parameters<typeof workspace.loadWorkspace>) => {
          const gate = loadGates.shift();
          const snapshot = await workspace.loadWorkspace(...args);
          if (gate) { gate.started(); await gate.release; }
          return snapshot;
        } };
      }
      return loaded;
    };
    try { (require('../extension') as typeof import('../extension')).activate(context); }
    finally { loader._load = originalLoad; }
    assert.ok(provider, 'Register a WebviewViewProvider rather than a native TreeView');
    const loaded = waitForPosted(posted => posted.type === 'state' && !posted.state.busy &&
      (persistence.multiRoot ? posted.state.workspace === null : posted.state.workspace !== null), 'Workspace load');
    await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
    await emit({ type: 'ready' });
    await loaded;
    if (persistence.multiRoot && !persistence.leaveWorkspaceUnselected) {
      await commands.get('agentscope.selectWorkspace')!();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const restart = async (): Promise<void> => {
    for (const subscription of context.subscriptions as Disposable[]) subscription.dispose();
    context.subscriptions = []; provider = undefined; latestState = undefined;
    await startExtension();
  };
  await startExtension();
  t.after(() => {
    for (const subscription of context.subscriptions as Disposable[]) { subscription.dispose(); }
    delete require.cache[extensionPath]; delete require.cache[viewPath];
  });
  assert.equal(webview.options.enableScripts, true);
  assert.match(webview.html, /Content-Security-Policy/);
  const nativeCommand = async (name: string): Promise<void> => {
    const action = commands.get(`agentscope.${name}`);
    assert.ok(action); await action();
  };
  const closePreviewDocument = (uri: MockUri): void => {
    for (const listener of closedDocumentListeners) listener({ uri });
  };
  const removeSelectedWorkspace = (): void => {
    // The selected root is the second folder; keep the first root unchanged so
    // this models a real folder-change event rather than an Extension Host restart.
    host.workspace.workspaceFolders = [{ name: 'Other workspace', uri: MockUri.file(path.join(path.dirname(root), 'other-workspace')), index: 0 }];
    for (const listener of workspaceFolderListeners) listener();
  };
  const fireConfigurationChange = (...names: string[]): void => {
    for (const listener of configurationListeners) listener({
      affectsConfiguration: (section, resource) => {
        if (resource) assert.equal(resource.fsPath, root);
        return names.some(name => name === section || name.startsWith(`${section}.`));
      },
    });
  };
  return { root, state, scope, projectRow, webview, messages, originals, errors, confirmations, confirmationDetails, applyAnswers, informationMessages, nativeCommand,
    backups, durable, storageControl, restart, dispatch, command, toggle, children, read, inputAnswers, quickAnswers, warningAnswers, configuration, chatgptConfiguration,
    textDocuments, watcherPatterns, activeWatcherPatterns, fireFileEvent, emitFileEvent, waitForState,
    pauseNextLoadedSnapshot, openedDocuments, beforeApplyConfirmation, beforeRestoreConfirmation, quickPickPrompts, previewProviders, executeCalls, closePreviewDocument,
    beforePresetInput, beforePresetConfirmation, beforeBackupSave, openAnswers, removeSelectedWorkspace, fireConfigurationChange };
}

/** Expand actual rows lazily; there are two access values on each returned file/folder. */
async function findPathRow(ui: Awaited<ReturnType<typeof activateInFixture>>, relative: string, projectName = 'project'): Promise<PermissionRow> {
  let parent = '.';
  let accumulated = '';
  let selected: PermissionRow | undefined;
  for (const segment of relative.split('/')) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    selected = (await ui.children(parent, 'project', projectName)).find(row => row.relative === accumulated);
    assert.ok(selected, `Cannot browse path: ${accumulated}`);
    parent = accumulated;
  }
  assert.ok(selected); return selected;
}

async function resourceRow(ui: Awaited<ReturnType<typeof activateInFixture>>, relative: string): Promise<PermissionRow> {
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.';
  const row = (await ui.children(parent, 'resource')).find(candidate => candidate.relative === relative);
  assert.ok(row, `Cannot browse workspace resource: ${relative}`);
  assert.equal(row.target, 'resource'); return row;
}

test('Workspace files show existing shared selection and apply an exact file write without enabling projects', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexFilesystemMode = 'strict';
  assert.equal(ui.state().resources?.label, 'Workspace files');
  assert.equal(ui.state().resources?.selectable, true, 'The resource section selects the permitted resource frontier without granting the whole workspace');
  const rootRows = await ui.children('.', 'resource');
  assert.ok(!rootRows.some(row => row.relative === 'project'));
  const instructions = await resourceRow(ui, 'Instructions');
  assert.equal(instructions.read.checked, true, 'Existing shared instructions remain selected');
  const originalProject = structuredClone(ui.scope());
  await ui.toggle(instructions, 'read', false);
  const guide = await resourceRow(ui, 'Instructions/guide.md');
  await ui.toggle(guide, 'write', true);
  const selected = await resourceRow(ui, guide.relative);
  assert.equal(selected.read.checked, true); assert.equal(selected.write.checked, true);
  assert.equal((await resourceRow(ui, 'Instructions/other.md')).read.checked, false);
  assert.equal((await resourceRow(ui, 'Instructions')).read.partial, true);
  assert.deepEqual(ui.state().resources!.scope!.read_paths, []);
  assert.deepEqual(ui.state().resources!.scope!.write_paths, ['Instructions/guide.md']);
  assert.deepEqual(ui.scope(), originalProject);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original, 'A resource checkbox only edits the draft');
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.deepEqual(saved.submodules.project, originalProject);
  assert.deepEqual(saved.shared_resources.write_paths, ['Instructions/guide.md']);
  const filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[path.join(ui.root, 'Instructions', 'guide.md')], 'write');
  assert.equal(filesystem[path.join(ui.root, 'Instructions')], undefined);
  assert.equal(filesystem[path.join(ui.root, 'project')], 'deny');
});

test('Root files and resource visibility save, reload and restore independently of project settings', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexFilesystemMode = 'strict';
  const readme = await resourceRow(ui, 'README.md');
  await ui.toggle(readme, 'read', true);
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'README.md' });
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'Instructions' });
  assert.equal(ui.state().resourceHidden?.['README.md'], true);
  assert.equal(ui.state().resourceHidden?.Instructions, true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Saved settings') as Record<string, any>;
  for (const section of ['files.exclude', 'search.exclude']) {
    assert.equal(settings[section]['README.md'], true); assert.equal(settings[section].Instructions, true);
  }
  assert.equal(settings['files.exclude']['**/.cache'], true); assert.equal(settings['editor.tabSize'], 4);
  assert.equal((await resourceRow(ui, 'README.md')).hidden, true);
  assert.equal((await resourceRow(ui, 'Instructions')).hidden, true);
  assert.equal(ui.scope().enabled, false);
  const filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[path.join(ui.root, 'README.md')], 'read');
  const confirmations = ui.confirmations.length;
  await ui.command('apply');
  assert.equal(ui.confirmations.length, confirmations, 'Reloaded resource visibility must be idempotent');
  await ui.command('restore');
  assert.deepEqual(ui.errors, []);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
});

test('Resource messages cannot enter projects, metadata or unsafe paths', async (t) => {
  const ui = await activateInFixture(t);
  const before = structuredClone(ui.state().resources?.scope);
  for (const relative of ['project', 'project/references/nested/paper.md', '.git/config', '../escape', '/absolute']) {
    await ui.dispatch({ type: 'toggle', workspaceId: ui.state().workspaceId, target: 'resource', name: '@workspace', relative, access: 'write', checked: true, directory: relative === 'project' });
  }
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'project' });
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleAccess', name: 'project' });
  assert.equal(ui.errors.length, 7);
  assert.deepEqual(ui.state().resources?.scope, before); assert.equal(ui.state().dirty, false);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
});

test('Resource edits obey workspace trust and a root project avoids duplicate workspace controls', async (t) => {
  const ui = await activateInFixture(t, false);
  await ui.toggle(await resourceRow(ui, 'README.md'), 'write', true);
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'Instructions' });
  assert.equal(ui.errors.length, 2); assert.ok(ui.errors.every(message => /Trust the workspace/.test(message)));
  assert.equal(ui.state().dirty, false);
  const rootUI = await activateInFixture(t, true, false, { path: '.' });
  assert.equal(rootUI.state().resources, undefined);
  assert.equal(rootUI.scope().path, '.');
});

test('Named presets save drafts without applying and activate access, visibility and profile options together', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await resourceRow(ui, 'Instructions/guide.md'), 'write', true);
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'Instructions' });
  ui.configuration.profileName = 'editing';
  ui.inputAnswers.push('Editing');
  await ui.command('savePreset');
  assert.equal(ui.state().preset, 'Editing');
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original, 'Save preset must not apply scope files');
  const storePath = '.vscode/agentscope-presets.json';
  const first = parseJsoncStrict(await ui.read(storePath), 'Preset store') as Record<string, any>;
  assert.deepEqual(first.presets.Editing.registry.shared_resources.write_paths, ['Instructions/guide.md']);
  assert.equal(first.presets.Editing.resourceHidden.Instructions, true);

  await ui.toggle(await resourceRow(ui, 'Instructions/guide.md'), 'write', false);
  await ui.dispatch({ type: 'command', workspaceId: ui.state().workspaceId, target: 'resource', command: 'toggleResourceVisibility', relative: 'Instructions' });
  ui.configuration.profileName = 'reading';
  ui.inputAnswers.push('Reading');
  await ui.command('savePreset');
  const second = parseJsoncStrict(await ui.read(storePath), 'Preset store') as Record<string, any>;
  assert.deepEqual(Object.keys(second.presets).sort(), ['Editing', 'Reading']);
  assert.equal(second.presets.Reading.options.profileName, 'reading');

  ui.quickAnswers.push('Editing'); ui.warningAnswers.push('Load preset');
  await ui.command('activatePreset');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.state().preset, 'Editing'); assert.equal(ui.state().dirty, false);
  let saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.deepEqual(saved.shared_resources.write_paths, ['Instructions/guide.md']);
  assert.equal(saved.submodules.project.enabled, false);
  let settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Settings') as Record<string, any>;
  assert.equal(settings['files.exclude'].Instructions, true);
  assert.equal((TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).default_permissions, 'editing');

  ui.quickAnswers.push('Reading');
  await ui.command('activatePreset');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.state().preset, 'Reading'); assert.equal(ui.state().dirty, false);
  saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.deepEqual(saved.shared_resources.write_paths, []);
  settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Settings') as Record<string, any>;
  assert.equal(settings['files.exclude'].Instructions, false);
  assert.equal(settings['search.exclude'].Instructions, false);
  assert.equal((TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).default_permissions, 'reading');
});

test('Preset replacement and deletion preserve other saved names and do not rewrite scope files', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('First'); await ui.command('savePreset');
  ui.inputAnswers.push('Second'); await ui.command('savePreset');
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  ui.inputAnswers.push('First'); ui.warningAnswers.push('Replace'); await ui.command('savePreset');
  const storePath = '.vscode/agentscope-presets.json';
  let store = parseJsoncStrict(await ui.read(storePath), 'Preset store') as Record<string, any>;
  assert.ok(store.presets.First.registry.shared_resources.read_paths.includes('README.md'));
  assert.ok(!store.presets.Second.registry.shared_resources.read_paths.includes('README.md'));
  ui.quickAnswers.push('First'); ui.warningAnswers.push('Delete'); await ui.command('deletePreset');
  store = parseJsoncStrict(await ui.read(storePath), 'Preset store') as Record<string, any>;
  assert.deepEqual(Object.keys(store.presets), ['Second']); assert.deepEqual(ui.errors, []);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
});

test('Updating an existing preset requires replacement confirmation and preserves other names', async (t) => {
  const ui = await activateInFixture(t);
  const storePath = '.vscode/agentscope-presets.json';
  ui.inputAnswers.push('First'); await ui.command('savePreset');
  ui.inputAnswers.push('Second'); await ui.command('savePreset');
  const before = await ui.read(storePath);
  const previous = parseJsoncStrict(before, 'Preset store') as Record<string, any>;
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);

  ui.quickAnswers.push('First');
  await ui.command('updatePreset');
  assert.equal(await ui.read(storePath), before, 'Dismissing Replace must keep the saved preset unchanged');

  ui.quickAnswers.push('First'); ui.warningAnswers.push('Replace');
  await ui.command('updatePreset');
  const updated = parseJsoncStrict(await ui.read(storePath), 'Preset store') as Record<string, any>;
  assert.deepEqual(Object.keys(updated.presets).sort(), ['First', 'Second']);
  assert.ok(updated.presets.First.registry.shared_resources.read_paths.includes('README.md'));
  assert.deepEqual(updated.presets.Second, previous.presets.Second);
  assert.equal(ui.state().preset, 'First');
  assert.equal(ui.state().dirty, true, 'The updated snapshot still needs Apply to publish its profile');
  assert.deepEqual(ui.errors, []);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
});

test('Cancelling Update preset or returning an unavailable name does not create a preset', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Existing'); await ui.nativeCommand('savePreset');
  const before = await ui.read('.vscode/agentscope-presets.json');
  await ui.nativeCommand('updatePreset');
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);
  assert.deepEqual(ui.errors, []);

  ui.quickAnswers.push('Missing'); ui.warningAnswers.push('Replace');
  await ui.nativeCommand('updatePreset');
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /preset.*(?:missing|unknown|available|changed|exist)|(?:unknown|missing).*preset/i);
});

test('Preset confirmations reject concurrent file edits instead of overwriting or deleting them', async (t) => {
  for (const action of ['savePreset', 'updatePreset', 'deletePreset']) {
    await t.test(action, async subtest => {
      const ui = await activateInFixture(subtest);
      ui.inputAnswers.push('Existing'); await ui.nativeCommand('savePreset');
      const target = path.join(ui.root, '.vscode/agentscope-presets.json');
      const external = parseJsoncStrict(await ui.read('.vscode/agentscope-presets.json'), 'Preset store') as Record<string, any>;
      external.presets.Existing.options.allowNetwork = true;
      external.owner = 'Keep the edit made while confirmation was open';
      const concurrent = JSON.stringify(external);
      ui.beforePresetConfirmation.push(async () => { await fs.writeFile(target, concurrent); });
      if (action === 'savePreset') ui.inputAnswers.push('Existing');
      else ui.quickAnswers.push('Existing');
      ui.warningAnswers.push(action === 'deletePreset' ? 'Delete' : 'Replace');
      await ui.nativeCommand(action);
      assert.equal(await ui.read('.vscode/agentscope-presets.json'), concurrent);
      assert.equal(ui.errors.length, 1);
      assert.match(ui.errors[0], /preset.*changed|changed.*preset/i);
    });
  }
});

test('Activating a preset changed while its picker is open does not load a stale scope', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Existing'); await ui.nativeCommand('savePreset');
  const before = structuredClone(ui.scope());
  const target = '.vscode/agentscope-presets.json';
  const store = parseJsoncStrict(await ui.read(target), 'Preset store') as Record<string, any>;
  store.presets.Existing.registry.submodules.project.enabled = true;
  const concurrent = JSON.stringify(store);
  ui.quickAnswers.push(async () => {
    await fs.writeFile(path.join(ui.root, target), concurrent);
    return 'Existing';
  });
  ui.warningAnswers.push('Load preset');
  await ui.nativeCommand('activatePreset');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /presets.*changed/i);
  assert.deepEqual(ui.scope(), before);
  assert.equal(ui.confirmations.length, 0);
  assert.equal(await ui.read(target), concurrent);
  assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
});

test('Untrusted workspaces cannot save, update, activate or delete presets', async (t) => {
  const ui = await activateInFixture(t, false);
  for (const action of ['savePreset', 'updatePreset', 'activatePreset', 'deletePreset']) await ui.command(action);
  assert.equal(ui.errors.length, 4); assert.ok(ui.errors.every(error => /Trust the workspace/.test(error)));
  await assert.rejects(fs.stat(path.join(ui.root, '.vscode', 'agentscope-presets.json')), { code: 'ENOENT' });
  assert.equal(ui.state().dirty, false);
});

test('Explicit Apply uses the selected Codex runtime root and preserves local policy paths', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  ui.configuration.codexRuntime = 'auto';
  ui.configuration.codexWorkspaceRoot = '/mnt/d/MyApps';
  ui.chatgptConfiguration.runCodexInWindowsSubsystemForLinux = true;
  assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
  assert.equal(ui.confirmations.length, 0);

  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  const filesystem = codex.permissions.agentscope.filesystem;
  assert.equal(filesystem['/mnt/d/MyApps/.agentscope/access.md'], undefined);
  assert.equal(filesystem['/mnt/d/MyApps/project/references'], 'read');
  assert.equal(filesystem['/mnt/d/MyApps/project/drafts'], 'write');
  assert.equal(filesystem[path.join(ui.root, SCOPE_CONFIGURATION_FILE)], undefined);
  assert.equal(filesystem[':workspace_roots'], undefined, 'The profile must use only the explicitly selected workspace');
  assert.equal(filesystem['/mnt/d/MyApps'], undefined, 'Mapping does not grant the entire root');
  assert.equal(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root).submodules.project.path, 'project');
  assert.equal(ui.state().dirty, false);
});

test('Auto with a native Windows runtime explains root reads and grants only selected writes on every host', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.configuration.codexFilesystemMode = 'auto';
  await ui.toggle(await resourceRow(ui, 'Instructions/guide.md'), 'write', true);
  assert.match(ui.state().scopeNotice ?? '', /Native Windows.*outside selected paths/i);
  assert.match(ui.state().scopeNotice ?? '', /outside selected paths.*disabled projects/i);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);

  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.match(ui.confirmations.at(-1)!, /Windows compatibility.*outside selected paths remain readable/i);
  assert.match(ui.confirmationDetails.at(-1)!, /OS-level reads of all files.*disabled projects/i);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  const filesystem = codex.permissions.agentscope.filesystem;
  assert.equal(filesystem[':root'], 'read', 'The elevated Windows helper must receive effective root read');
  assert.equal(Object.values(filesystem).includes('deny'), false, 'Disabled projects cannot add unsupported Windows read denies');
  assert.deepEqual(Object.entries(filesystem).filter(([, mode]) => mode === 'write'), [
    [':tmpdir', 'write'], ['E:\\Remote\\Workspace\\Instructions\\guide.md', 'write'],
  ]);
  assert.equal(filesystem['E:\\Remote\\Workspace'], undefined);
  assert.equal(filesystem[path.join(ui.root, 'Instructions', 'guide.md')], undefined);
  assert.equal(codex.model, 'example-model');
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.equal(saved.submodules.project.enabled, false, 'The compatibility fallback must not enable the disabled project');
  assert.deepEqual(saved.shared_resources.write_paths, ['Instructions/guide.md']);
});

test('Cancelling Windows compatibility leaves all policies, config files and recovery journals untouched', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.applyAnswers.push(undefined);
  await ui.toggle(await resourceRow(ui, 'Instructions/guide.md'), 'write', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.match(ui.confirmations.at(-1)!, /Windows compatibility/i);
  assert.equal(ui.state().dirty, true);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.backups.size, 0);
  assert.equal(ui.durable.size, 0);
});

test('An old preset without filesystem mode inherits the configured Strict choice', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.inputAnswers.push('Legacy');
  await ui.command('savePreset');
  const storePath = '.vscode/agentscope-presets.json';
  const store = parseJsoncStrict(await ui.read(storePath), 'Legacy preset') as Record<string, any>;
  delete store.presets.Legacy.options.codexFilesystemMode;
  await fs.writeFile(path.join(ui.root, storePath), `${JSON.stringify(store, null, 2)}\n`);
  ui.configuration.codexFilesystemMode = 'strict';
  await ui.restart();
  ui.quickAnswers.push('Legacy');
  await ui.command('activatePreset');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.state().preset, 'Legacy');
  const filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[':root'], 'deny');
  assert.equal(filesystem['E:\\Remote\\Workspace\\project'], 'deny');
  assert.doesNotMatch(ui.confirmations.at(-1)!, /Apply Windows compatibility/i);
  assert.match(ui.state().scopeNotice ?? '', /Strict.*Windows.*compatible sandbox/i);
});

test('Explicit Auto in a preset resolves current runtime settings and replaces Windows grants when switched to WSL', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  ui.configuration.codexFilesystemMode = 'auto';
  ui.inputAnswers.push('Portable');
  await ui.command('savePreset');
  const storePath = '.vscode/agentscope-presets.json';
  const store = parseJsoncStrict(await ui.read(storePath), 'Portable preset') as Record<string, any>;
  // Older presets can carry an explicit Auto mode without pinning a runtime root.
  delete store.presets.Portable.options.codexWorkspaceRoot;
  await fs.writeFile(path.join(ui.root, storePath), `${JSON.stringify(store, null, 2)}\n`);
  ui.configuration.codexFilesystemMode = 'strict';
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  await ui.restart();
  ui.quickAnswers.push('Portable');
  await ui.command('activatePreset');
  assert.deepEqual(ui.errors, []);
  let filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[':root'], 'read', 'The preset explicitly saved Auto, so it overrides the later configured Strict setting');
  assert.equal(filesystem['E:\\Remote\\Workspace\\project\\drafts'], 'write');

  ui.configuration.codexWorkspaceRoot = '/mnt/e/Remote/Workspace';
  ui.chatgptConfiguration.runCodexInWindowsSubsystemForLinux = true;
  ui.fireConfigurationChange('agentscope.codexWorkspaceRoot', 'chatgpt.runCodexInWindowsSubsystemForLinux');
  await ui.waitForState(model => model.dirty && model.scopeNotice === undefined, 'Runtime switch draft');
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[':root'], 'deny');
  assert.equal(filesystem['/mnt/e/Remote/Workspace/project/references'], 'read');
  assert.equal(filesystem['/mnt/e/Remote/Workspace/project/drafts'], 'write');
  assert.equal(Object.keys(filesystem).some(key => key.startsWith('E:')), false, 'The obsolete native runtime profile must be replaced');
  assert.doesNotMatch(ui.confirmations.at(-1)!, /Apply Windows compatibility/i);
  assert.equal(ui.state().dirty, false);
});

test('Relevant VS Code setting changes mark a draft and refresh the notice without writing configuration', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexWorkspaceRoot = '/mnt/e/Remote/Workspace';
  await ui.command('apply');
  const before = new Map<string, string>();
  for (const file of ['AGENTS.md', SCOPE_CONFIGURATION_FILE, '.vscode/settings.json', '.codex/config.toml']) before.set(file, await ui.read(file));
  const confirmations = ui.confirmations.length;
  ui.fireConfigurationChange('editor.tabSize');
  assert.equal(ui.state().dirty, false, 'Unrelated editor settings must not dirty scope configuration');
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.fireConfigurationChange('agentscope.codexWorkspaceRoot');
  await ui.waitForState(model => model.dirty && /Native Windows/.test(model.scopeNotice ?? ''), 'Native runtime notice');
  for (const [file, original] of before) assert.equal(await ui.read(file), original);
  assert.equal(ui.confirmations.length, confirmations);

  ui.configuration.codexWorkspaceRoot = '/mnt/e/Remote/Workspace';
  ui.chatgptConfiguration.runCodexInWindowsSubsystemForLinux = true;
  ui.fireConfigurationChange('chatgpt.runCodexInWindowsSubsystemForLinux');
  await ui.waitForState(model => model.dirty && model.scopeNotice === undefined, 'WSL runtime notice');
  for (const [file, original] of before) assert.equal(await ui.read(file), original);
  assert.equal(ui.confirmations.length, confirmations);
});

test('Runtime changes during Apply confirmation abort before publishing the stale native profile', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.beforeApplyConfirmation.push(async () => {
    ui.configuration.codexWorkspaceRoot = '/mnt/e/Remote/Workspace';
    ui.chatgptConfiguration.runCodexInWindowsSubsystemForLinux = true;
    ui.fireConfigurationChange('agentscope.codexWorkspaceRoot', 'chatgpt.runCodexInWindowsSubsystemForLinux');
  });
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /runtime.*settings changed.*Preview/i);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.backups.size, 0);
  assert.equal(ui.durable.size, 0);
  assert.equal(ui.state().dirty, true);
});

test('Webview commands migrate editor selections, publish config and restore originals', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexFilesystemMode = 'strict';
  assert.ok(ui.watcherPatterns.includes(SCOPE_CONFIGURATION_FILE));
  assert.ok(ui.watcherPatterns.includes('.vscode/agentscope-presets.json'));
  assert.ok(!ui.watcherPatterns.includes('AGENTS.md') && !ui.watcherPatterns.includes('.agentscope/access.md'));
  await ui.command('toggleAccess', 'project');
  await ui.command('toggleVisibility', 'project');
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.confirmations.length, 1);
  assert.equal(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)).submodules.project.enabled, true);
  assert.match(await ui.read('AGENTS.md'), /Keep my editorial rules/);
  assert.doesNotMatch(await ui.read('AGENTS.md'), /BEGIN AgentScope|access\.md/);
  await assert.rejects(fs.stat(path.join(ui.root, '.agentscope/access.md')), { code: 'ENOENT' });
  const settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Settings') as Record<string, any>;
  assert.equal(settings['files.exclude'].project, true);
  assert.equal(settings['search.exclude'].project, true);
  assert.equal(settings['editor.tabSize'], 4);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  assert.equal(codex.default_permissions, 'agentscope');
  assert.equal(codex.model, 'example-model');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, 'project', 'references')], 'read');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, 'project', 'drafts')], 'write');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, '.agentscope/access.md')], undefined);
  assert.equal(ui.state().dirty, false);
  await ui.command('restore');
  assert.deepEqual(ui.errors, []);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.projectRow().enabled, false);
});

test('A second Apply updates JSON selections without rewriting user instructions', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.generateCodexProfile = false;
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const agents = await ui.read('AGENTS.md');
  const configuration = await ui.read(SCOPE_CONFIGURATION_FILE);
  const settings = await ui.read('.vscode/settings.json');
  const codex = await ui.read('.codex/config.toml');
  assert.ok(readScopeConfiguration(configuration).shared_resources.read_paths.includes('README.md'));
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', false);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), agents);
  assert.ok(!readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)).shared_resources.read_paths.includes('README.md'));
  assert.equal(await ui.read('.vscode/settings.json'), settings);
  assert.equal(await ui.read('.codex/config.toml'), codex);
  await ui.command('restore');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), configuration);
  assert.ok((await resourceRow(ui, 'README.md')).read.checked);
});

test('After migration, custom AGENTS text is independent of editor selections', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const custom = '# My instructions\n\n<!-- BEGIN AgentScope access reference -->\nMy custom text.\n<!-- END AgentScope access reference -->\n';
  await fs.writeFile(path.join(ui.root, 'AGENTS.md'), custom);
  await ui.command('refresh');
  assert.equal(ui.state().configurationError, null);
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), custom);
  assert.ok(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)).shared_resources.read_paths.includes('README.md'));
});

test('Unsaved JSON selections block Apply before any writes', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const before = await ui.read(SCOPE_CONFIGURATION_FILE);
  const backup = structuredClone(ui.backups.get('backup:' + ui.root));
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  const filename = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
  ui.textDocuments.push({ isDirty: true, uri: MockUri.file(filename), fileName: filename });
  await ui.command('apply');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), before);
  assert.deepEqual(ui.backups.get('backup:' + ui.root), backup);
});

test('Refreshing a corrupt configuration clears stale grants and recovers after repair', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  await ui.command('apply');
  const valid = await ui.read(SCOPE_CONFIGURATION_FILE);
  const filename = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
  await fs.writeFile(filename, '{ invalid settings');
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.equal(ui.state().projects.length, 0);
  await fs.writeFile(filename, valid);
  await ui.command('refresh');
  assert.equal(ui.state().configurationError, null);
  assert.equal(ui.scope().enabled, true);
  assert.equal(ui.activeWatcherPatterns().filter(name => name === SCOPE_CONFIGURATION_FILE).length, 1);
});

test('Deleting AGENTS.md after migration does not remove scopes or recreate instructions', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  await ui.command('apply');
  const configuration = await ui.read(SCOPE_CONFIGURATION_FILE);
  const savedScope = structuredClone(ui.scope());
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await ui.command('refresh');
  assert.equal(ui.state().configurationError, null);
  assert.deepEqual(ui.scope(), savedScope);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), configuration);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('AGENTS.md created during Apply after migration is left untouched', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await ui.command('refresh');
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  const custom = '# New instructions\nPreserve this file.\n';
  ui.beforeApplyConfirmation.push(async () => { await fs.writeFile(path.join(ui.root, 'AGENTS.md'), custom); });
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), custom);
});

test('Configuration watcher failures retain the workspace and automatically recover after repair', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  await ui.command('apply');
  const valid = await ui.read(SCOPE_CONFIGURATION_FILE);
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), '{ invalid settings');
  await ui.emitFileEvent(SCOPE_CONFIGURATION_FILE);
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().projects.length, 0);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.deepEqual(ui.errors, [], 'Background watcher failures stay in the panel');
  await ui.nativeCommand('openConfiguration');
  assert.equal(ui.openedDocuments.at(-1)?.fsPath, path.join(ui.root, SCOPE_CONFIGURATION_FILE));
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), valid);
  await ui.emitFileEvent(SCOPE_CONFIGURATION_FILE);
  assert.equal(ui.state().configurationError, null);
  assert.equal(ui.scope().enabled, true);
  assert.equal(ui.activeWatcherPatterns().filter(name => name === SCOPE_CONFIGURATION_FILE).length, 1);
});

test('A missing legacy sidecar stays visible as a migration error until explicitly repaired', async (t) => {
  const saved = writeAccessFiles(policy(registry()), null, registry());
  const ui = await activateInFixture(t, true, false, {}, async root => {
    await fs.mkdir(path.join(root, '.agentscope'));
    await fs.writeFile(path.join(root, 'AGENTS.md'), saved.agents);
  });
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.deepEqual(ui.errors, []);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  await fs.writeFile(path.join(ui.root, '.agentscope/access.md'), saved.access);
  await ui.command('refresh');
  assert.equal(ui.state().configurationError, null);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('.agentscope/access.md'), saved.access);
  assert.equal(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)).submodules.project.enabled, true);
});

test('Multi-root startup waits for an explicit workspace selection without opening a picker', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, undefined, { multiRoot: true, leaveWorkspaceUnselected: true });
  assert.equal(ui.state().workspace, null);
  assert.deepEqual(ui.state().projects, []);
  assert.deepEqual(ui.quickPickPrompts, []);
  assert.deepEqual(ui.errors, []);
  assert.deepEqual(ui.informationMessages, []);
  assert.equal(ui.activeWatcherPatterns().length, 0);
  assert.equal(await ui.read('AGENTS.md'), ui.originals.get('AGENTS.md'));
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });

  await ui.nativeCommand('selectWorkspace');
  assert.equal(ui.quickPickPrompts.length, 1);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.equal(ui.state().projects.length, 1);
  assert.deepEqual(ui.errors, []);
});

test('Delete and create events during load queue the latest configuration snapshot', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const valid = await ui.read(SCOPE_CONFIGURATION_FILE);
  const gate = ui.pauseNextLoadedSnapshot();
  const before = ui.state().workspaceId;
  ui.fireFileEvent(SCOPE_CONFIGURATION_FILE);
  await gate.started;
  try {
    await fs.unlink(path.join(ui.root, SCOPE_CONFIGURATION_FILE));
    ui.fireFileEvent(SCOPE_CONFIGURATION_FILE, 'delete');
    await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), '{ latest invalid');
    ui.fireFileEvent(SCOPE_CONFIGURATION_FILE, 'create');
  } finally { gate.release(); }
  await ui.waitForState(model => !!model.configurationError && !model.busy, 'Latest configuration error');
  assert.ok(ui.state().workspaceId > before);
  assert.deepEqual(ui.errors, []);
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), valid);
  await ui.emitFileEvent(SCOPE_CONFIGURATION_FILE);
  assert.equal(ui.state().configurationError, null);
  assert.equal(ui.activeWatcherPatterns().length, 5);
});

test('Untrusted webview commands and permission checkboxes cannot write configuration', async (t) => {
  const ui = await activateInFixture(t, false);
  assert.equal(ui.state().trusted, false); assert.match(ui.state().message, /Trust this workspace/);
  await ui.command('toggleAccess', 'project');
  await ui.command('toggleVisibility', 'project');
  await ui.toggle(ui.projectRow(), 'read', true);
  await ui.command('apply');
  assert.equal(ui.errors.length, 4); assert.ok(ui.errors.every(message => /Trust the workspace/.test(message)));
  assert.equal(ui.state().dirty, false); assert.equal(ui.projectRow().enabled, false); assert.equal(ui.projectRow().hidden, false);
  assert.equal(ui.confirmations.length, 0); assert.equal(ui.backups.size, 0);
  for (const [file, original] of ui.originals) { assert.equal(await ui.read(file), original); }
});

test('Webview Apply aborts before writing when backup persistence fails', async (t) => {
  const ui = await activateInFixture(t, true, true);
  await ui.command('toggleAccess', 'project');
  await ui.command('apply');
  assert.equal(ui.confirmations.length, 1); assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /workspace-state storage failure/);
  assert.equal(ui.backups.size, 0); assert.equal(ui.state().dirty, true);
  assert.equal(ui.informationMessages.some(message => /Settings saved/.test(message)), false);
  for (const [file, original] of ui.originals) { assert.equal(await ui.read(file), original, `Backup failure changed ${file}`); }
});

test('A same-row read checkbox resets disabled whole-project grants and applies only its file', async (t) => {
  const ui = await activateInFixture(t, true, false, { restrict_paths: false, read_paths: ['.'], write_paths: ['.'] });
  ui.configuration.codexFilesystemMode = 'strict';
  const relative = 'references/nested/paper.md';
  const file = await findPathRow(ui, relative);
  assert.equal(file.directory, false); assert.equal(file.read.checked, false); assert.equal(file.write.checked, false);
  await ui.toggle(file, 'read', true);
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.scope().enabled, true); assert.equal(ui.scope().restrict_paths, true);
  assert.deepEqual(ui.scope().read_paths, [relative]); assert.deepEqual(ui.scope().write_paths, []);
  const selected = await findPathRow(ui, relative);
  assert.equal(selected.read.checked, true); assert.equal(selected.write.checked, false);
  const parent = await findPathRow(ui, 'references/nested');
  assert.equal(parent.read.checked, false); assert.equal(parent.read.partial, true);
  const sibling = await findPathRow(ui, 'references/nested/sibling.md');
  assert.equal(sibling.read.checked, false); assert.equal(sibling.write.checked, false);
  for (const [filePath, original] of ui.originals) { assert.equal(await ui.read(filePath), original); }

  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root).submodules.project;
  assert.deepEqual(saved.read_paths, [relative]); assert.deepEqual(saved.write_paths, []);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  const filesystem = codex.permissions.agentscope.filesystem;
  const projectRoot = path.join(ui.root, 'project');
  const exactFile = path.join(projectRoot, ...relative.split('/'));
  assert.equal(filesystem[projectRoot], undefined);
  assert.equal(filesystem[path.join(projectRoot, 'references')], undefined);
  assert.equal(filesystem[path.join(projectRoot, 'references', 'nested')], undefined);
  assert.deepEqual(Object.keys(filesystem).filter(key => key.startsWith(projectRoot + path.sep)), [exactFile]);
  assert.equal(filesystem[exactFile], 'read');
  assert.equal(await ui.read('project/references/nested/paper.md'), 'Selected reference\n');
  assert.equal(await ui.read('project/references/nested/sibling.md'), 'Unselected reference\n');
});

test('A same-row write checkbox implies read and clearing read removes writable coverage', async (t) => {
  const ui = await activateInFixture(t, true, false, { restrict_paths: false, read_paths: ['.'], write_paths: ['.'] });
  const relative = 'references/nested/paper.md';
  let file = await findPathRow(ui, relative);
  await ui.toggle(file, 'write', true);
  assert.deepEqual(ui.scope().read_paths, []); assert.deepEqual(ui.scope().write_paths, [relative]);
  file = await findPathRow(ui, relative);
  assert.equal(file.read.checked, true); assert.equal(file.write.checked, true);
  await ui.toggle(file, 'read', false);
  assert.deepEqual(ui.scope().read_paths, []); assert.deepEqual(ui.scope().write_paths, []);
  file = await findPathRow(ui, relative);
  assert.equal(file.read.checked, false); assert.equal(file.write.checked, false);

  await ui.toggle(file, 'write', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root).submodules.project;
  assert.deepEqual(saved.read_paths, []); assert.deepEqual(saved.write_paths, [relative]);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  const filesystem = codex.permissions.agentscope.filesystem;
  const projectRoot = path.join(ui.root, 'project');
  const exactFile = path.join(projectRoot, ...relative.split('/'));
  assert.deepEqual(Object.keys(filesystem).filter(key => key.startsWith(projectRoot + path.sep)), [exactFile]);
  assert.equal(filesystem[projectRoot], undefined); assert.equal(filesystem[exactFile], 'write');
});

test('A displayed file replaced by a folder cannot gain access through a stale webview row', async (t) => {
  const ui = await activateInFixture(t, true, false, { restrict_paths: false, read_paths: ['.'], write_paths: ['.'] });
  const relative = 'references/nested/paper.md';
  const file = await findPathRow(ui, relative);
  assert.equal(file.directory, false);
  const before = structuredClone(ui.scope());
  const filename = path.join(ui.root, 'project', ...relative.split('/'));
  await fs.unlink(filename); await fs.mkdir(filename);
  await ui.toggle(file, 'read', true);
  assert.equal(ui.errors.length, 1); assert.match(ui.errors[0], /changed since it was displayed.*Refresh/i);
  assert.deepEqual(ui.scope(), before); assert.equal(ui.state().dirty, false); assert.equal(ui.backups.size, 0);
  for (const [config, original] of ui.originals) { assert.equal(await ui.read(config), original); }
});

test('Malformed, unsupported and escaping webview messages never create access grants', async (t) => {
  const ui = await activateInFixture(t);
  const before = structuredClone(ui.scope());
  const epoch = ui.state().workspaceId;
  const base = { type: 'toggle', workspaceId: epoch, name: 'project', relative: 'references/nested/paper.md', access: 'read', checked: true, directory: false };
  const invalid = [
    { ...base, checked: 'true' },
    { ...base, access: 'execute' },
    { ...base, relative: '../outside' },
    { ...base, relative: '/outside' },
    { ...base, relative: 'references/**' },
    { type: 'command', workspaceId: epoch, command: 'agentscope.apply' },
  ];
  for (const message of invalid) {
    const errorCount = ui.errors.length;
    await ui.dispatch(message);
    assert.equal(ui.errors.length, errorCount + 1);
    assert.deepEqual(ui.scope(), before); assert.equal(ui.state().dirty, false);
  }
  assert.equal(ui.backups.size, 0); assert.equal(ui.confirmations.length, 0);
  for (const [config, original] of ui.originals) { assert.equal(await ui.read(config), original); }
});

test('Messages from an earlier workspace epoch cannot select files or Apply', async (t) => {
  const ui = await activateInFixture(t);
  const oldEpoch = ui.state().workspaceId;
  await ui.command('refresh');
  const currentEpoch = ui.state().workspaceId;
  assert.notEqual(currentEpoch, oldEpoch);
  const before = structuredClone(ui.scope());
  await ui.dispatch({ type: 'toggle', workspaceId: oldEpoch, name: 'project', relative: 'references/nested/paper.md', access: 'write', checked: true, directory: false });
  await ui.dispatch({ type: 'command', workspaceId: oldEpoch, command: 'apply' });
  assert.equal(ui.errors.length, 2); assert.ok(ui.errors.every(message => /workspace|stale|refresh/i.test(message)));
  assert.equal(ui.state().workspaceId, currentEpoch); assert.deepEqual(ui.scope(), before);
  assert.equal(ui.state().dirty, false); assert.equal(ui.confirmations.length, 0); assert.equal(ui.backups.size, 0);
  for (const [config, original] of ui.originals) { assert.equal(await ui.read(config), original); }
});

test('Apply checkpoints exact JSON selections and recovers after deletion without instruction files', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [] });
  await ui.command('apply');
  const configuration = await ui.read(SCOPE_CONFIGURATION_FILE);
  const selected = structuredClone(ui.scope());
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  const saved = validateCheckpoint(checkpoint, ui.root);
  assert.equal(saved.version, 2);
  assert.equal(saved.configuration, configuration);
  await fs.unlink(path.join(ui.root, SCOPE_CONFIGURATION_FILE));
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  ui.backups.clear();
  await ui.restart();
  assert.equal(ui.state().recoveryAvailable, true);
  assert.ok(ui.state().projects.every(row => !row.enabled));
  await ui.command('recover');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), configuration);
  assert.deepEqual(ui.scope(), selected);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, '.agentscope/access.md')), { code: 'ENOENT' });
  const undo = ui.backups.get('backup:' + ui.root) as Array<{path: string; before: string | null}>;
  assert.equal(undo.length, 1);
  assert.equal(undo[0].before, null);
});

test('Recovery restores a corrupt policy from an error panel and Undo returns the exact corrupt bytes', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  await ui.command('apply');
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(SCOPE_CONFIGURATION_FILE);
  const settings = await ui.read('.vscode/settings.json');
  const codex = await ui.read('.codex/config.toml');
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  const corrupt = 'Broken access settings: { definitely not a registry\n';
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), corrupt, 'utf8');
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().recoveryAvailable, true);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint, 'Loading corrupt files cannot replace the last valid snapshot');
  assert.equal(ui.errors.length, 1);

  await ui.command('recover');
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.state().configurationError, null);
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), access);
  assert.equal(await ui.read('.vscode/settings.json'), settings); assert.equal(await ui.read('.codex/config.toml'), codex);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).write.checked, true);

  await ui.command('restore');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), corrupt, 'Undo Recovery must preserve the overwritten corrupt file for review');
  assert.equal(await ui.read('AGENTS.md'), agents);
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().recoveryAvailable, true);
  assert.equal(await ui.read('.vscode/settings.json'), settings); assert.equal(await ui.read('.codex/config.toml'), codex);
});

test('Apply cannot write any workspace file when checkpoint persistence fails', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  const files = new Map<string, string>();
  for (const file of ['AGENTS.md', SCOPE_CONFIGURATION_FILE, '.vscode/settings.json', '.codex/config.toml']) files.set(file, await ui.read(file));
  await ui.toggle(await resourceRow(ui, 'README.md'), 'write', true);
  ui.storageControl.failCheckpointSave = true;
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /recovery-checkpoint storage failure/);
  assert.equal(ui.state().dirty, true);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
  for (const [file, text] of files) assert.equal(await ui.read(file), text, `Failed checkpoint persistence changed ${file}`);
});

test('Recovery respects unsaved configuration editors and persists Undo before writing', async (t) => {
  const savedRegistry = registry({ project: project({ enabled: true }) });
  const saved = writeScopeConfiguration(null, savedRegistry);
  for (const reason of ['unsaved editor', 'backup storage failure'] as const) await t.test(reason, async caseTest => {
    const ui = await activateInFixture(caseTest, true, reason === 'backup storage failure', {}, async root => {
      await fs.writeFile(path.join(root, SCOPE_CONFIGURATION_FILE), saved);
    });
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.state().recoveryAvailable, true);
    const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
    const corrupt = '{ damaged selections';
    await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), corrupt);
    await ui.command('refresh');
    if (reason === 'unsaved editor') {
      const filename = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
      ui.textDocuments.push({ isDirty: true, uri: MockUri.file(filename), fileName: filename });
    }
    await ui.command('recover');
    assert.equal(ui.errors.length, 2);
    assert.match(ui.errors.at(-1)!, reason === 'unsaved editor' ? /unsaved|save/i : /workspace-state storage failure/);
    assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), corrupt);
    assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
  });
});

test('A complete legacy Apply backup imports selections without restoring legacy policy files', async (t) => {
  const selected = registry({ project: project({ enabled: true }) });
  const saved = writeAccessFiles(policy(selected), null, selected);
  const ui = await activateInFixture(t, true, false, {}, async root => {
    await fs.unlink(path.join(root, 'AGENTS.md'));
  }, { initialBackup: root => [
    { path: path.join(root, 'AGENTS.md'), before: null, after: saved.agents },
    { path: path.join(root, '.agentscope/access.md'), before: null, after: saved.access },
  ] });
  assert.equal(ui.state().recoveryAvailable, true);
  await ui.command('recover');
  assert.deepEqual(ui.errors, []);
  assert.deepEqual(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)), selected);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, '.agentscope/access.md')), { code: 'ENOENT' });
});

test('Corrupt durable checkpoints remain unavailable and cannot write policy files', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, async root => {
    await fs.unlink(path.join(root, 'AGENTS.md'));
  }, { initialCheckpoint: root => ({ version: 1, root, agents: 'corrupt', access: 'corrupt', savedAt: new Date().toISOString() }) });
  assert.equal(ui.state().recoveryAvailable, false);
  const originalSettings = await ui.read('.vscode/settings.json');
  await ui.command('recover');
  assert.equal(ui.errors.length, 1, 'An invalid saved checkpoint must be rejected');
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(await ui.read('.vscode/settings.json'), originalSettings);
});

test('Recovery and reconfiguration reject stale panel messages and Restricted Mode', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const oldEpoch = ui.state().workspaceId;
  await ui.command('refresh');
  const files = new Map<string, string>();
  for (const file of ['AGENTS.md', SCOPE_CONFIGURATION_FILE, '.vscode/settings.json', '.codex/config.toml']) files.set(file, await ui.read(file));
  for (const command of ['recover', 'reconfigure']) await ui.dispatch({ type: 'command', workspaceId: oldEpoch, command });
  assert.equal(ui.errors.length, 2); assert.ok(ui.errors.every(message => /workspace changed/i.test(message)));
  assert.equal(ui.state().dirty, false);
  for (const [file, text] of files) assert.equal(await ui.read(file), text);

  const restricted = await activateInFixture(t, false);
  for (const command of ['recover', 'reconfigure']) await restricted.command(command);
  assert.equal(restricted.errors.length, 2); assert.ok(restricted.errors.every(message => /Trust the workspace/.test(message)));
  for (const [file, text] of restricted.originals) assert.equal(await restricted.read(file), text);
});

test('Reconfigure turns corrupt policy into an empty editable draft and Apply keeps original user instructions', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  await ui.command('apply');
  const userText = 'Keep this important custom instruction exactly, even during repair.\n';
  const agents = `${await ui.read('AGENTS.md')}\n${userText}`;
  const broken = 'This is a broken access file that should remain until Apply.\n';
  await fs.writeFile(path.join(ui.root, 'AGENTS.md'), agents, 'utf8');
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), broken, 'utf8');
  await ui.command('refresh');
  assert.equal(ui.errors.length, 1); assert.ok(ui.state().configurationError);
  await ui.command('reconfigure');
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.state().configurationError, null); assert.equal(ui.state().dirty, true);
  assert.equal(ui.scope().enabled, false);
  assert.deepEqual(ui.scope().read_paths, []); assert.deepEqual(ui.scope().write_paths, []);
  assert.deepEqual(ui.state().resources!.scope!.read_paths, []); assert.deepEqual(ui.state().resources!.scope!.write_paths, []);
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), broken, 'Reconfigure only creates a draft');

  const selectedPath = 'references/nested/sibling.md';
  await ui.toggle(await findPathRow(ui, selectedPath), 'write', true);
  await ui.command('apply');
  assert.equal(ui.errors.length, 1); assert.equal(ui.state().configurationError, null);
  assert.ok((await ui.read('AGENTS.md')).includes(userText));
  const selected = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.deepEqual(selected.submodules.project.write_paths, [selectedPath]);
  assert.deepEqual(selected.submodules.project.read_paths, []); assert.deepEqual(selected.shared_resources.read_paths, []);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).read.checked, false);
  assert.equal((await findPathRow(ui, selectedPath)).write.checked, true);
  assert.equal(ui.state().recoveryAvailable, true);
  await ui.command('restore');
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), broken);
});

test('A new ordinary project without configuration starts disabled and creates policies on its first precise Apply', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, async root => {
    for (const file of ['AGENTS.md', '.vscode/settings.json', '.codex/config.toml']) await fs.unlink(path.join(root, file));
    await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  });
  assert.deepEqual(ui.errors, []); assert.equal(ui.state().configurationError, null);
  assert.equal(ui.state().recoveryAvailable, false); assert.equal(ui.state().projects.length, 1);
  const rootProject = ui.state().projects[0];
  assert.equal(rootProject.scope!.path, '.'); assert.equal(rootProject.enabled, false);
  assert.deepEqual(rootProject.scope!.read_paths, []); assert.deepEqual(rootProject.scope!.write_paths, []);
  const selectedPath = 'project/references/nested/paper.md';
  await ui.toggle(await findPathRow(ui, selectedPath, rootProject.name), 'read', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []); assert.equal(ui.state().dirty, false); assert.equal(ui.state().recoveryAvailable, true);
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.equal(saved.submodules[rootProject.name].enabled, true);
  assert.deepEqual(saved.submodules[rootProject.name].read_paths, [selectedPath]);
  assert.deepEqual(saved.submodules[rootProject.name].write_paths, []);
  assert.ok(validateCheckpoint(ui.durable.get(checkpointKey(ui.root)), ui.root));
  await ui.restart();
  assert.deepEqual(ui.errors, []);
  assert.equal((await findPathRow(ui, selectedPath, rootProject.name)).read.checked, true);
  assert.equal((await findPathRow(ui, 'project/references/nested/sibling.md', rootProject.name)).read.checked, false);
});

test('Failed Apply and failed staging cleanup cannot replace the committed good recovery snapshot', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const savedKey = checkpointKey(ui.root);
  const good = structuredClone(ui.durable.get(savedKey));
  const access = await ui.read(SCOPE_CONFIGURATION_FILE);
  const main = await ui.read(SCOPE_CONFIGURATION_FILE);
  await ui.toggle(await resourceRow(ui, 'README.md'), 'write', true);
  ui.storageControl.failPendingCleanup = true;
  ui.beforeApplyConfirmation.push(() => fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), main + '\nPreserve my competing edit.\n', 'utf8'));
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /changed.*refresh.*cleanup also failed/is);
  assert.deepEqual(ui.durable.get(savedKey), good);
  assert.ok(ui.durable.has(`${savedKey}.pending`), 'Prepared data remains distinguishable from committed data');
  assert.notEqual(await ui.read(SCOPE_CONFIGURATION_FILE), access, 'Preserve the competing edit without publishing the planned selections');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), main + '\nPreserve my competing edit.\n');
});

test('An unfinished staged Apply cannot bootstrap recovery from its pre-write Undo record', async (t) => {
  const value = registry({ project: project({ enabled: true, restrict_paths: false }) });
  const saved = writeAccessFiles(policy(value), null, value);
  const ui = await activateInFixture(t, true, false, {}, root => fs.unlink(path.join(root, 'AGENTS.md')), {
    initialPending: root => ({ version: 1, root, agents: saved.agents, access: saved.access, savedAt: new Date().toISOString() }),
    initialBackup: root => [
      { path: path.join(root, 'AGENTS.md'), before: null, after: saved.agents },
      { path: path.join(root, '.agentscope/access.md'), before: null, after: saved.access },
    ],
  });
  assert.equal(ui.state().recoveryAvailable, false);
  assert.equal(ui.durable.has(checkpointKey(ui.root)), false);
  await ui.restart();
  assert.equal(ui.state().recoveryAvailable, false);
  await ui.command('recover');
  assert.equal(ui.errors.length, 1);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
});

test('Recovery locks registered commands before awaiting policy reads', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), 'Corrupt policy\n', 'utf8');
  await ui.command('refresh');
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const readFile = fs.readFile.bind(fs);
  let intercepted = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (!intercepted && String(args[0]) === path.join(ui.root, SCOPE_CONFIGURATION_FILE)) {
      intercepted = true; enter(); await held;
    }
    return readFile(...args);
  });
  const recovering = ui.nativeCommand('recover');
  await entered;
  try {
    assert.equal(ui.state().busy, true);
    await ui.nativeCommand('selectWorkspace');
    await ui.nativeCommand('recover');
    assert.equal(ui.errors.length, 3);
    assert.ok(ui.errors.slice(1).every(error => /Wait for the current configuration operation/i.test(error)));
    assert.equal(ui.state().workspace, path.basename(ui.root));
  } finally { release(); await recovering; }
  assert.equal(ui.state().configurationError, null);
});

test('An unchanged Apply refuses externally deleted JSON selections', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  await fs.unlink(path.join(ui.root, SCOPE_CONFIGURATION_FILE));
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /input changed.*refresh/i);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
});

test('Recovery remains undoable from a configuration error panel when unrelated settings are malformed', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const savedPolicy = await ui.read(SCOPE_CONFIGURATION_FILE);
  const corruptedPolicy = 'Corrupted policy text must be preserved for Undo.\n';
  const corruptedSettings = '{ malformed editor configuration';
  await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), corruptedPolicy);
  await fs.writeFile(path.join(ui.root, '.vscode/settings.json'), corruptedSettings);
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  await ui.command('recover');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), savedPolicy);
  assert.match(ui.state().configurationError!, /invalid JSON\/JSONC/);
  const errorCount = ui.errors.length;

  await ui.command('restore');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), corruptedPolicy, 'Restore must use the selected root while loading remains blocked');
  assert.equal(await ui.read('.vscode/settings.json'), corruptedSettings, 'Undo recovery must not repair unrelated settings');
  assert.equal(ui.backups.has(`backup:${ui.root}`), false);
  assert.ok(ui.state().configurationError, 'The faithfully restored corrupt policy remains a configuration error');
  assert.ok(ui.errors.length <= errorCount + 1, 'Only reloading the restored corrupt configuration may report an error');
});

test('Restore refuses corrupt, duplicate or unrelated Undo targets without changing any files', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(SCOPE_CONFIGURATION_FILE);
  const readme = await ui.read('README.md');
  const foreign = path.join(path.dirname(ui.root), 'other-workspace-not-selected.md');
  await fs.writeFile(foreign, 'Other workspace contents.\n');
  const change = { path: path.join(ui.root, 'AGENTS.md'), before: 'Different previous text\n', after: agents };
  const invalidBackups = [
    [null],
    [change, change],
    [{ path: path.join(ui.root, 'README.md'), before: 'Unrelated file must not be overwritten.\n', after: readme }],
    [{ path: foreign, before: 'Foreign root must not be overwritten.\n', after: 'Other workspace contents.\n' }],
    [{ ...change, after: 42 }],
  ];
  for (const invalid of invalidBackups) {
    ui.backups.set(`backup:${ui.root}`, invalid);
    const errors = ui.errors.length;
    await ui.nativeCommand('restore');
    assert.equal(ui.errors.length, errors + 1);
    assert.equal(await ui.read('AGENTS.md'), agents);
    assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), access);
    assert.equal(await ui.read('README.md'), readme);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'Other workspace contents.\n');
  }
});

test('Apply and Restore recheck unsaved editors after their native confirmation dialogs', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const policy = await ui.read(SCOPE_CONFIGURATION_FILE);
  const filename = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
  const editor = { isDirty: false, uri: MockUri.file(filename), fileName: filename };
  ui.textDocuments.push(editor);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  ui.beforeApplyConfirmation.push(async () => { editor.isDirty = true; });
  await ui.command('apply');
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), policy);
  assert.match(ui.errors.at(-1)!, /unsaved|save or discard/i);
  editor.isDirty = false;
  await ui.command('apply');
  const applied = await ui.read(SCOPE_CONFIGURATION_FILE);
  ui.beforeRestoreConfirmation.push(async () => { editor.isDirty = true; });
  const errors = ui.errors.length;
  await ui.nativeCommand('restore');
  assert.equal(ui.errors.length, errors + 1);
  assert.match(ui.errors.at(-1)!, /unsaved|save or discard/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), applied);
  assert.ok(ui.backups.has(`backup:${ui.root}`));
});

test('Preview shows the current and proposed access policy for a selected leaf without saving any files', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const before = await ui.read(SCOPE_CONFIGURATION_FILE);
  const main = await ui.read('AGENTS.md');
  const backup = structuredClone(ui.backups.get(`backup:${ui.root}`));
  const leaf = 'references/nested/paper.md';
  await ui.toggle(await findPathRow(ui, leaf), 'write', true);
  ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => path.normalize(item.label) === path.normalize(SCOPE_CONFIGURATION_FILE)));
  await ui.command('preview');

  assert.deepEqual(ui.errors, []);
  const diff = ui.executeCalls.find(call => call.name === 'vscode.diff');
  assert.ok(diff, 'Selecting a pending file must open a VS Code diff');
  const content = ui.previewProviders.get('agentscope-preview');
  assert.ok(content);
  const [beforeUri, afterUri, title] = diff.args as [MockUri, MockUri, string];
  assert.equal(content.provideTextDocumentContent(beforeUri), before);
  const proposed = content.provideTextDocumentContent(afterUri);
  const proposedRegistry = readScopeConfiguration(proposed);
  assert.deepEqual(proposedRegistry.submodules.project.write_paths, [leaf]);
  assert.match(title, /AgentScope:/);
  const prompt = ui.quickPickPrompts.at(-1)!;
  assert.match(prompt.options.title, /Preview pending/);
  assert.match(prompt.options.placeHolder, /current.*left.*proposed.*right/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), before, 'Preview is read-only');
  assert.equal(await ui.read('AGENTS.md'), main);
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), backup);
  assert.equal(ui.state().dirty, true);
});

test('Preview of unchanged configuration explains that there are no pending changes without an empty picker', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const pickerCount = ui.quickPickPrompts.length;
  await ui.command('preview');
  assert.equal(ui.quickPickPrompts.length, pickerCount);
  assert.ok(ui.informationMessages.some(message => /No pending configuration changes/i.test(message)));
  assert.equal(ui.executeCalls.filter(call => call.name === 'vscode.diff').length, 0);
  assert.equal(ui.state().dirty, false);
  assert.deepEqual(ui.errors, []);
});

test('Canceling Preview preserves the draft and opening each pending output shows its exact snapshots', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'read', true);
  const originals = new Map<string, string>();
  for (const name of ['AGENTS.md', '.vscode/settings.json', '.codex/config.toml']) originals.set(name, await ui.read(name));
  await ui.command('preview'); // An unanswered quick pick models cancellation.
  assert.equal(ui.executeCalls.filter(call => call.name === 'vscode.diff').length, 0);
  assert.equal(ui.state().dirty, true);
  const pending = ui.quickPickPrompts.at(-1)!.items as Array<{ label: string; description: string; detail: string; change: { before: string | null; after: string } }>;
  assert.equal(pending.length, 4);
  const content = ui.previewProviders.get('agentscope-preview');
  assert.ok(content);
  for (const file of pending) {
    assert.ok(file.detail?.trim(), `Explain the purpose of ${file.label}`);
    ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => item.label === file.label));
    await ui.command('preview');
    const diff = ui.executeCalls.filter(call => call.name === 'vscode.diff').at(-1)!;
    const [beforeUri, afterUri] = diff.args as [MockUri, MockUri];
    assert.equal(content.provideTextDocumentContent(beforeUri), file.change.before ?? '');
    assert.equal(content.provideTextDocumentContent(afterUri), file.change.after);
  }
  for (const [name, original] of originals) assert.equal(await ui.read(name), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.state().dirty, true);
  assert.equal(ui.backups.size, 0);
  assert.deepEqual(ui.errors, []);
});

test('A native Preview keeps its selected workspace locked while choosing a pending file', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  const original = await ui.read(SCOPE_CONFIGURATION_FILE);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  ui.quickAnswers.push(async (items: Array<{ label: string }>) => {
    enter(); await held; return items.find(item => path.normalize(item.label) === path.normalize(SCOPE_CONFIGURATION_FILE));
  });
  const previewing = ui.nativeCommand('preview');
  await entered;
  try {
    assert.equal(ui.state().busy, true);
    for (const action of ['selectWorkspace', 'apply', 'restore']) await ui.nativeCommand(action);
    assert.equal(ui.errors.length, 3);
    assert.ok(ui.errors.every(error => /Wait for the current|Wait for.*selection/i.test(error)));
    assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), original);
  } finally { release(); await previewing; }
  assert.equal(ui.state().busy, false);
  assert.equal(ui.executeCalls.filter(call => call.name === 'vscode.diff').length, 1);
  assert.equal(ui.state().dirty, true);
});

test('Closing a Preview document releases its stored snapshot without changing other open previews', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => path.normalize(item.label) === path.normalize(SCOPE_CONFIGURATION_FILE)));
  await ui.command('preview');
  const content = ui.previewProviders.get('agentscope-preview');
  assert.ok(content);
  const diff = ui.executeCalls.find(call => call.name === 'vscode.diff');
  assert.ok(diff);
  const [before, after] = diff.args as [MockUri, MockUri];
  assert.ok(content.provideTextDocumentContent(after));
  const afterContents = content.provideTextDocumentContent(after);
  ui.closePreviewDocument(before);
  assert.equal(content.provideTextDocumentContent(before), '');
  assert.equal(content.provideTextDocumentContent(after), afterContents);
  ui.closePreviewDocument(after);
  assert.equal(content.provideTextDocumentContent(after), '');
});

test('Windows URI casing cannot bypass unsaved-editor guards for Apply, Recover or Restore', { skip: process.platform !== 'win32' }, async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const saved = await ui.read(SCOPE_CONFIGURATION_FILE);
  const filename = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
  const editor = { isDirty: true, uri: MockUri.file(filename.toLowerCase()), fileName: filename };
  assert.notEqual(editor.uri.fsPath, filename, 'The fixture exercises Windows canonical URI casing');
  ui.textDocuments.push(editor);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  await ui.command('apply');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), saved);

  editor.isDirty = false;
  await ui.command('apply');
  const applied = await ui.read(SCOPE_CONFIGURATION_FILE);
  editor.isDirty = true;
  await ui.nativeCommand('restore');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), applied);

  editor.isDirty = false;
  const corrupted = 'Policy bytes that must survive an unsaved-editor conflict.\n';
  await fs.writeFile(filename, corrupted);
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  editor.isDirty = true;
  await ui.command('recover');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), corrupted);
});

test('Workspace files parent selects all safe resource roots without granting project access or storing the workspace root', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply'); // Include generated policy files in the visible frontier.
  const beforeProject = structuredClone(ui.scope());
  const parent = ui.state().resources;
  assert.ok(parent?.selectable);
  await ui.toggle(parent, 'read', true);
  assert.equal(ui.state().resources?.read.checked, true);
  assert.equal(ui.state().resources?.write.checked, false);
  const read = ui.state().resources!.scope!.read_paths;
  assert.ok(read.includes('Instructions'));
  assert.ok(read.includes('README.md'));
  assert.ok(read.includes('.vscode'));
  assert.ok(!read.includes('.') && !read.some(relative => relative === 'project' || relative.startsWith('project/')));
  assert.deepEqual(ui.scope(), beforeProject);
  await ui.toggle(ui.state().resources!, 'write', true);
  assert.equal(ui.state().resources?.write.checked, true);
  assert.equal(ui.state().resources?.read.checked, true);
  assert.ok(!ui.state().resources!.scope!.write_paths.includes('.'));
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const persisted = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.equal(persisted.submodules.project.enabled, false);
  assert.ok(!persisted.shared_resources.read_paths.includes('.') && !persisted.shared_resources.write_paths.includes('.'));
  assert.deepEqual(ui.scope(), beforeProject);
});

test('Workspace files parent shows partial Read and Write after a descendant is deselected, and clears shared grants independently', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const beforeProject = structuredClone(ui.scope());
  await ui.toggle(ui.state().resources!, 'write', true);
  await ui.toggle(await resourceRow(ui, 'Instructions/guide.md'), 'read', false);
  assert.equal(ui.state().resources?.write.checked, false);
  assert.equal(ui.state().resources?.write.partial, true);
  assert.equal(ui.state().resources?.read.checked, false);
  assert.equal(ui.state().resources?.read.partial, true);
  assert.equal((await resourceRow(ui, 'Instructions/guide.md')).read.checked, false);
  assert.equal((await resourceRow(ui, 'Instructions/guide.md')).write.checked, false);
  assert.equal((await resourceRow(ui, 'Instructions/other.md')).write.checked, true);
  assert.deepEqual(ui.scope(), beforeProject);
  await ui.toggle(ui.state().resources!, 'read', true);
  assert.equal(ui.state().resources?.read.checked, true);
  assert.equal(ui.state().resources?.write.partial, true);
  await ui.toggle(ui.state().resources!, 'write', false);
  assert.equal(ui.state().resources?.write.checked, false);
  assert.equal(ui.state().resources?.write.partial, false);
  assert.equal(ui.state().resources?.read.checked, true);
  assert.deepEqual(ui.state().resources!.scope!.write_paths, []);
  await ui.toggle(ui.state().resources!, 'read', false);
  assert.deepEqual(ui.state().resources!.scope!.read_paths, []);
  assert.deepEqual(ui.state().resources!.scope!.write_paths, []);
  assert.equal(ui.state().resources?.read.partial, false);
  assert.deepEqual(ui.scope(), beforeProject);
  assert.deepEqual(ui.errors, []);
});

test('A native project configuration dialog keeps its draft stable and defers external reloads until selection finishes', async (t) => {
  const ui = await activateInFixture(t);
  const before = await ui.read('AGENTS.md');
  const epoch = ui.state().workspaceId;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  ui.quickAnswers.push('project');
  ui.quickAnswers.push(async (items: Array<{ id: string }>) => {
    enter(); await held; return items.find(item => item.id === 'access');
  });
  ui.quickAnswers.push({ id: 'read' }, { id: 'done' });
  const configuring = ui.nativeCommand('configure');
  await entered;
  const external = `${before}\nPreserve this competing policy edit.\n`;
  try {
    assert.equal(ui.state().busy, true);
    for (const action of ['selectWorkspace', 'apply', 'toggleAccess']) await ui.nativeCommand(action);
    assert.equal(ui.errors.length, 3);
    assert.ok(ui.errors.every(error => /Wait for the current|Wait for.*selection/i.test(error)));
    await fs.writeFile(path.join(ui.root, 'AGENTS.md'), external);
    ui.fireFileEvent(SCOPE_CONFIGURATION_FILE);
    assert.equal(ui.state().workspaceId, epoch, 'The watcher must defer replacing a draft while the dialog is open');
  } finally { release(); await configuring; }
  assert.equal(ui.state().busy, false);
  assert.equal(ui.state().workspaceId, epoch);
  assert.equal(ui.scope().enabled, true);
  assert.deepEqual(ui.scope().read_paths, ['.']);
  assert.deepEqual(ui.scope().write_paths, []);
  assert.equal(ui.state().dirty, true);
  assert.match(ui.state().message, /Workspace configuration changed outside AgentScope/);
  await ui.command('apply');
  assert.match(ui.errors.at(-1)!, /changed.*refresh/i);
  assert.equal(await ui.read('AGENTS.md'), external);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
});

test('An unchanged Recovery preserves the previous Undo journal, explains the no-op and still checks for competing edits', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const previousUndo = structuredClone(ui.backups.get(`backup:${ui.root}`));
  assert.ok(Array.isArray(previousUndo) && previousUndo.length > 0);
  const agents = await ui.read('AGENTS.md');
  const policy = await ui.read(SCOPE_CONFIGURATION_FILE);
  await ui.command('recover');
  assert.deepEqual(ui.errors, []);
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousUndo);
  assert.equal(await ui.read('AGENTS.md'), agents);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), policy);
  const message = ui.informationMessages.at(-1)!;
  assert.match(message, /saved.*configuration.*already on disk/i);
  assert.match(message, /no files changed/i);
  assert.doesNotMatch(message, /Restore.*undo.*recovery/i);

  const target = path.join(ui.root, SCOPE_CONFIGURATION_FILE);
  const competing = `${policy}\nPreserve this concurrent access policy note.\n`;
  const readFile = fs.readFile.bind(fs);
  let changed = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const text = await readFile(...args);
    if (!changed && String(args[0]) === target) {
      changed = true;
      await fs.writeFile(target, competing);
    }
    return text;
  });
  const informationCount = ui.informationMessages.length;
  await ui.command('recover');
  assert.equal(changed, true);
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /input changed.*refresh/i, 'Even a no-op recovery must execute its snapshot guards');
  assert.equal(await readFile(target, 'utf8'), competing);
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousUndo);
  assert.equal(ui.informationMessages.length, informationCount, 'A conflicting no-op must not report success');
});

test('Preset Save, Update and Delete refuse dirty editors before dialogs and after their confirmations', async (t) => {
  const ui = await activateInFixture(t);
  const target = path.join(ui.root, '.vscode', 'agentscope-presets.json');
  ui.inputAnswers.push('Existing');
  await ui.command('savePreset');
  const before = await ui.read('.vscode/agentscope-presets.json');
  const editor = { isDirty: true, uri: MockUri.file(process.platform === 'win32' ? target.toUpperCase() : target), fileName: target };
  ui.textDocuments.push(editor);
  await ui.nativeCommand('savePreset');
  await ui.nativeCommand('updatePreset');
  await ui.nativeCommand('deletePreset');
  assert.equal(ui.errors.length, 3);
  assert.ok(ui.errors.every(error => /Save or discard.*agentscope-presets/i.test(error)));
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);

  editor.isDirty = false;
  ui.quickAnswers.push('Existing'); ui.warningAnswers.push('Replace');
  ui.beforePresetConfirmation.push(async () => { editor.isDirty = true; });
  await ui.nativeCommand('updatePreset');
  assert.match(ui.errors.at(-1)!, /Save or discard/);
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);

  editor.isDirty = false;
  ui.inputAnswers.push('Existing');
  ui.warningAnswers.push('Replace');
  ui.beforePresetConfirmation.push(async () => { editor.isDirty = true; });
  await ui.nativeCommand('savePreset');
  assert.match(ui.errors.at(-1)!, /Save or discard/);
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);

  editor.isDirty = false;
  ui.quickAnswers.push('Existing'); ui.warningAnswers.push('Delete');
  ui.beforePresetConfirmation.push(async () => { editor.isDirty = true; });
  await ui.nativeCommand('deletePreset');
  assert.match(ui.errors.at(-1)!, /Save or discard/);
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);
  assert.equal(ui.errors.length, 6);
});

test('File changes during preset input are reconciled after both saving and cancellation', async (t) => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? 'cancelled input' : 'saved preset', async (t) => {
      const ui = await activateInFixture(t);
      const epoch = ui.state().workspaceId;
      const damaged = '{ invalid configuration';
      if (!cancelled) ui.inputAnswers.push('Writing');
      ui.beforePresetInput.push(async () => {
        assert.equal(ui.state().busy, true);
        await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), damaged);
        ui.fireFileEvent(SCOPE_CONFIGURATION_FILE);
        assert.equal(ui.state().workspaceId, epoch);
      });
      await ui.nativeCommand('savePreset');
      if (!cancelled) {
        await ui.waitForState(model => model.dirty && !model.busy, 'Saved preset remains a pending export');
        assert.match(ui.state().message, /configuration changed outside AgentScope/i);
        ui.warningAnswers.push('Discard draft');
        await ui.command('refresh');
      }
      await ui.waitForState(model => !!model.configurationError && !model.busy, 'Queued invalid policy reload');
      assert.equal(ui.state().projects.length, 0);
      assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), damaged);
      assert.ok(ui.state().workspaceId > epoch);
    });
  }
});

test('A policy event after the post-Apply snapshot is reloaded before the panel stays idle', async (t) => {
  const ui = await activateInFixture(t);
  const gate = ui.pauseNextLoadedSnapshot();
  const applying = ui.nativeCommand('apply');
  await gate.started;
  const damaged = '{ invalid configuration';
  try {
    await fs.writeFile(path.join(ui.root, SCOPE_CONFIGURATION_FILE), damaged);
    ui.fireFileEvent(SCOPE_CONFIGURATION_FILE);
  } finally { gate.release(); }
  await applying;
  await ui.waitForState(model => !!model.configurationError && !model.busy, 'Late post-Apply policy error');
  assert.equal(ui.state().projects.length, 0);
  assert.equal(await ui.read(SCOPE_CONFIGURATION_FILE), damaged);
});

test('A queued own Apply event preserves the applied preset when its choices still match', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.command('savePreset');
  const gate = ui.pauseNextLoadedSnapshot();
  const applying = ui.nativeCommand('apply');
  await gate.started;
  const epoch = ui.state().workspaceId;
  try { ui.fireFileEvent(SCOPE_CONFIGURATION_FILE); } finally { gate.release(); }
  await applying;
  await ui.waitForState(model => model.workspaceId >= epoch + 2 && !model.busy, 'Own-write revalidation');
  assert.equal(ui.state().preset, 'Writing');
  assert.equal(ui.state().dirty, false);
  assert.equal(ui.state().configurationError, null);
  assert.deepEqual(ui.errors, []);
});

test('Removing a selected later workspace during preset input aborts writing and clears its selection', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, undefined, { multiRoot: true });
  ui.inputAnswers.push('Must not be saved');
  ui.beforePresetInput.push(async () => { ui.removeSelectedWorkspace(); });
  await ui.nativeCommand('savePreset');
  assert.equal(ui.state().workspace, null);
  assert.equal(ui.state().projects.length, 0);
  assert.equal(ui.state().busy, false);
  assert.match(ui.errors.at(-1)!, /no longer open/i);
  await assert.rejects(fs.stat(path.join(ui.root, '.vscode', 'agentscope-presets.json')), { code: 'ENOENT' });
});

test('Removing a selected workspace during Apply confirmation aborts before policy writes', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, undefined, { multiRoot: true });
  ui.beforeApplyConfirmation.push(async () => { ui.removeSelectedWorkspace(); });
  await ui.nativeCommand('apply');
  assert.equal(ui.state().workspace, null);
  assert.match(ui.errors.at(-1)!, /no longer open/i);
  assert.equal(await ui.read('AGENTS.md'), ui.originals.get('AGENTS.md'));
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.backups.size, 0);
});

test('Reserved Add project names reject without changing the current draft or project map', async (t) => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    await t.test(name, async (t) => {
      const ui = await activateInFixture(t);
      const before = structuredClone(ui.state().projects);
      ui.openAnswers.push([MockUri.file(path.join(ui.root, 'Instructions'))]);
      ui.inputAnswers.push(name);
      await ui.nativeCommand('addFolder');
      assert.equal(ui.errors.length, 1);
      assert.match(ui.errors[0], /Invalid project name/i);
      assert.deepEqual(ui.state().projects, before);
      assert.equal(ui.state().dirty, false);
      assert.equal(await ui.read('AGENTS.md'), ui.originals.get('AGENTS.md'));
    });
  }
});

test('Removing the workspace during awaited Apply backup storage aborts before publication and cleans prepared recovery', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, undefined, { multiRoot: true });
  ui.beforeBackupSave.push(async () => { ui.removeSelectedWorkspace(); });
  await ui.nativeCommand('apply');
  assert.equal(ui.state().workspace, null);
  assert.match(ui.errors.at(-1)!, /no longer open/i);
  assert.equal(await ui.read('AGENTS.md'), ui.originals.get('AGENTS.md'));
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.backups.get(`backup:${ui.root}`), undefined);
  assert.equal(ui.durable.get(`${checkpointKey(ui.root)}.pending`), undefined);
});

test('Preset writes recheck an editor that becomes dirty after transaction staging', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Existing');
  await ui.nativeCommand('savePreset');
  const before = await ui.read('.vscode/agentscope-presets.json');
  const target = path.join(ui.root, '.vscode', 'agentscope-presets.json');
  const editor = { isDirty: false, uri: MockUri.file(target), fileName: target };
  ui.textDocuments.push(editor);
  const open = fs.open.bind(fs);
  let staged = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.agentscope-') && String(args[0]).includes('agentscope-presets.json')) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); staged = true; editor.isDirty = true; };
    }
    return handle;
  });
  ui.inputAnswers.push('New draft');
  await ui.nativeCommand('savePreset');
  assert.equal(staged, true);
  assert.match(ui.errors.at(-1)!, /Save or discard.*agentscope-presets/i);
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), before);
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ['settings.json', 'agentscope-presets.json'].sort());
});


test('The panel discovers ordinary sibling folders when no access registration exists', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, async (root) => {
    await fs.unlink(path.join(root, 'AGENTS.md'));
    await fs.mkdir(path.join(root, 'Sibling'));
  });
  assert.deepEqual(ui.state().projects.map(row => row.scope?.path).sort(), ['Instructions', 'Sibling', 'project']);
  assert.ok(ui.state().projects.every(row => row.enabled === false && row.scope?.restrict_paths === true));
  assert.ok(ui.state().resources);
  assert.deepEqual(ui.errors, []);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('Adding multiple child folders replaces an empty disabled root without transferring access', async (t) => {
  const ui = await activateInFixture(t, true, false, { path: '.', read_paths: [], write_paths: [] });
  const original = await ui.read('AGENTS.md');
  const previousWorkspaceId = ui.state().workspaceId;
  ui.openAnswers.push([MockUri.file(path.join(ui.root, 'project')), MockUri.file(path.join(ui.root, 'Instructions'))]);
  await ui.nativeCommand('addFolder');
  assert.ok(ui.state().workspaceId > previousWorkspaceId, 'New project boundaries must invalidate previously loaded folder rows');
  assert.deepEqual(ui.state().projects.map(row => row.scope?.path).sort(), ['Instructions', 'project']);
  for (const row of ui.state().projects) {
    assert.equal(row.scope?.enabled, false);
    assert.equal(row.scope?.restrict_paths, true);
    assert.deepEqual(row.scope?.read_paths, []);
    assert.deepEqual(row.scope?.write_paths, []);
    assert.equal(row.scope?.instruction_file, null);
  }
  assert.ok(ui.state().resources);
  assert.equal(ui.state().dirty, true);
  assert.equal(await ui.read('AGENTS.md'), original, 'Adding folders must remain a draft until Apply');
  await ui.nativeCommand('apply');
  const saved = readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE), ui.root);
  assert.deepEqual(Object.values(saved!.submodules).map(module => module.path).sort(), ['Instructions', 'project']);
  assert.deepEqual(ui.errors, []);
});

test('Adding child projects preserves a disabled root with existing scope choices', async (t) => {
  const ui = await activateInFixture(t, true, false, { path: '.', read_paths: ['project/references'], write_paths: [] });
  const original = await ui.read('AGENTS.md');
  const before = structuredClone(ui.state().projects);
  ui.openAnswers.push([MockUri.file(path.join(ui.root, 'project'))]);
  ui.inputAnswers.push('Child');
  await ui.nativeCommand('addFolder');
  assert.match(ui.errors.at(-1)!, /root.*configured scope choices.*Remove that project entry/i);
  assert.deepEqual(ui.state().projects, before);
  assert.equal(ui.state().dirty, false);
  assert.equal(await ui.read('AGENTS.md'), original);
});

test('A multi-folder selection with an outside path aborts without removing the empty root', async (t) => {
  const ui = await activateInFixture(t, true, false, { path: '.', read_paths: [], write_paths: [] });
  const original = await ui.read('AGENTS.md');
  ui.openAnswers.push([MockUri.file(path.join(ui.root, 'project')), MockUri.file(path.join(path.dirname(ui.root), 'outside'))]);
  await ui.nativeCommand('addFolder');
  assert.match(ui.errors.at(-1)!, /traverse|parent|outside/i);
  assert.equal(ui.scope().path, '.');
  assert.equal(ui.state().projects.length, 1);
  assert.equal(ui.state().dirty, false);
  assert.equal(await ui.read('AGENTS.md'), original);
});

test('Selecting one displayed project file validates that entry without rescanning sibling directories', async (t) => {
  const ui = await activateInFixture(t);
  const file = await findPathRow(ui, 'references/nested/paper.md');
  const original = await ui.read('AGENTS.md');
  const readdir = fs.readdir.bind(fs);
  const listings: string[] = [];
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listings.push(String(args[0]));
    return readdir(...args);
  });
  await ui.toggle(file, 'write', true);
  assert.deepEqual(listings, [], 'A leaf grant must not enumerate all of its siblings');
  assert.deepEqual(ui.scope().write_paths, ['references/nested/paper.md']);
  assert.deepEqual(ui.scope().read_paths, []);
  assert.equal(await ui.read('AGENTS.md'), original);
  assert.deepEqual(ui.errors, []);
});

test('Visibility and enable toggles reuse the displayed resource frontier', async (t) => {
  const ui = await activateInFixture(t);
  const readdir = fs.readdir.bind(fs);
  const listings: string[] = [];
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listings.push(String(args[0]));
    return readdir(...args);
  });
  await ui.command('toggleVisibility', 'project');
  await ui.command('toggleAccess', 'project');
  assert.deepEqual(listings, [], 'Changing project flags does not change workspace resource boundaries');
  assert.equal(ui.projectRow().hidden, true);
  assert.equal(ui.scope().enabled, true);
  assert.deepEqual(ui.errors, []);
});

test('The dedicated New Codex chat action always offers saved presets with the shortcut option disabled', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  assert.equal(ui.state().promptPresetForNewChat, false);
  await ui.nativeCommand('newChat');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(ui.quickPickPrompts.length, 1);
  assert.deepEqual((ui.quickPickPrompts[0].items as Array<{ label: string }>).map(item => item.label), ['Writing']);
  assert.match(ui.quickPickPrompts[0].options.title, /Preset for new Codex chat/);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
});

test('New Codex chat without a saved preset explains how to prepare one and opens no chat', async (t) => {
  const ui = await activateInFixture(t);
  await ui.nativeCommand('newChat');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /Save a preset/i);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(ui.confirmations.length, 0);
  for (const [file, original] of ui.originals) assert.equal(await ui.read(file), original);
});

test('The preset-prompt menu toggle updates the selected workspace setting', async (t) => {
  const ui = await activateInFixture(t);
  assert.equal(ui.state().promptPresetForNewChat, false);
  await ui.nativeCommand('toggleNewChatPresetPrompt');
  assert.equal(ui.configuration.promptPresetForNewChat, true);
  assert.equal(ui.state().promptPresetForNewChat, true);
  await ui.nativeCommand('toggleNewChatPresetPrompt');
  assert.equal(ui.configuration.promptPresetForNewChat, false);
  assert.equal(ui.state().promptPresetForNewChat, false);
  assert.deepEqual(ui.errors, []);
});

test('Cancelling a new-chat preset picker does not publish or open Codex', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;
  await ui.nativeCommand('newChat');
  assert.deepEqual(ui.errors, []);
  assert.match(ui.quickPickPrompts.at(-1)!.options.title, /Preset for new Codex chat/);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(ui.confirmations.length, 0);
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
});

test('Choosing a chat preset publishes its profile then requires manual native selection', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  assert.equal(ui.state().promptPresetForNewChat, false);
  ui.quickAnswers.push((items: Array<{label: string}>) => items.find(item => item.label === 'Writing'));
  await ui.nativeCommand('newChat');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.confirmations.length, 1);
  const opened = ui.executeCalls.filter(call => call.name === 'chatgpt.newChat');
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].args, [], 'Never pretend to bind a profile using unsupported command arguments');
  const guidance = ui.informationMessages.at(-1)!;
  assert.ok(guidance.includes(path.basename(ui.root)), 'Identify the workspace the user must select in Codex');
  assert.match(guidance, /Use workspace.*before sending.*select.*Writing.*Permissions/i);
  assert.match(guidance, /cannot select the workspace or profile automatically/i);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  assert.ok(codex.permissions['Writing - AgentScope'], 'The native menu must use the short preset name');
});

test('Cancelling profile publication prevents opening the scoped chat', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;
  ui.quickAnswers.push((items: Array<{label: string}>) => items.find(item => item.label === 'Writing'));
  ui.applyAnswers.push(undefined);
  await ui.nativeCommand('newChat');
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.match(ui.errors.at(-1)!, /Apply.*permission profiles/i);
});

test('Removed instruction and access-policy commands cannot be invoked from the panel', async (t) => {
  const ui = await activateInFixture(t);
  for (const command of ['openAgents', 'openAccess']) {
    await ui.command(command);
  }
  assert.equal(ui.openedDocuments.length, 0);
  assert.equal(ui.errors.length, 2);
});

test('A held chat preset picker blocks refresh, scope mutations and a second chat operation', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;
  const before = structuredClone(ui.scope());
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  ui.quickAnswers.push(async () => { enter(); await held; return undefined; });
  const opening = ui.nativeCommand('newChat');
  await entered;
  try {
    assert.equal(ui.state().busy, true);
    for (const action of ['refresh', 'toggleAccess', 'newChat', 'toggleNewChatPresetPrompt']) {
      await ui.nativeCommand(action);
    }
    assert.equal(ui.errors.length, 4);
    assert.ok(ui.errors.every(error => /Wait for.*(?:operation|chat)/i.test(error)));
    assert.deepEqual(ui.scope(), before);
    assert.equal(ui.configuration.promptPresetForNewChat, true);
    assert.equal(ui.quickPickPrompts.length, 1, 'A second command must not open another picker');
    assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
    assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
  } finally { release(); await opening; }
  assert.equal(ui.state().busy, false);
  assert.equal(ui.confirmations.length, 0);
});

test('Removing the workspace during scoped-chat publication prevents opening Codex', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, undefined, { multiRoot: true });
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;
  ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => item.label === 'Writing'));
  ui.beforeApplyConfirmation.push(async () => { ui.removeSelectedWorkspace(); });
  await ui.nativeCommand('newChat');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /workspace.*no longer open/i);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
  await assert.rejects(fs.stat(path.join(ui.root, SCOPE_CONFIGURATION_FILE)), { code: 'ENOENT' });
  assert.equal(ui.state().workspace, null);
  assert.equal(ui.state().busy, false);
});

test('A preset edited while choosing a chat is rejected before publishing or opening', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;
  ui.quickAnswers.push(async (items: Array<{ label: string }>) => {
    const store = parseJsoncStrict(await ui.read('.vscode/agentscope-presets.json'), 'Presets') as Record<string, any>;
    store.presets.Writing.options.allowNetwork = true;
    await fs.writeFile(path.join(ui.root, '.vscode/agentscope-presets.json'), JSON.stringify(store));
    ui.fireFileEvent('.vscode/agentscope-presets.json');
    return items.find(item => item.label === 'Writing');
  });
  await ui.nativeCommand('newChat');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /(?:chosen preset changed.*Choose it again|Saved presets changed.*refresh|input changed.*refresh)/i);
  assert.equal(ui.confirmations.length, 0);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(await ui.read('.codex/config.toml'), ui.originals.get('.codex/config.toml'));
  assert.equal(ui.state().busy, false);
});

test('The chat picker offers presets for the current Windows or WSL runtime family', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.codexFilesystemMode = 'strict';
  ui.configuration.codexRuntime = 'native';
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  ui.inputAnswers.push('Windows project');
  await ui.nativeCommand('savePreset');
  ui.configuration.codexRuntime = 'wsl';
  ui.configuration.codexWorkspaceRoot = '/mnt/z/Workspace';
  ui.inputAnswers.push('WSL project');
  await ui.nativeCommand('savePreset');
  ui.configuration.promptPresetForNewChat = true;

  ui.configuration.codexRuntime = 'native';
  ui.configuration.codexWorkspaceRoot = 'E:\\Remote\\Workspace';
  await ui.nativeCommand('newChat');
  assert.deepEqual((ui.quickPickPrompts.at(-1)!.items as Array<{ label: string }>).map(item => item.label), ['Windows project']);

  ui.configuration.codexRuntime = 'wsl';
  ui.configuration.codexWorkspaceRoot = '/mnt/z/Workspace';
  await ui.nativeCommand('newChat');
  assert.deepEqual((ui.quickPickPrompts.at(-1)!.items as Array<{ label: string }>).map(item => item.label), ['WSL project']);
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.executeCalls.filter(call => call.name === 'chatgpt.newChat').length, 0);
  assert.equal(ui.confirmations.length, 0);
});

test('Activating an older preset ignores its removed instruction-file dependency', async (t) => {
  const ui = await activateInFixture(t, true, false, { enabled: true });
  ui.configuration.codexFilesystemMode = 'strict';
  ui.inputAnswers.push('Legacy workflow');
  await ui.nativeCommand('savePreset');
  const store = parseJsoncStrict(await ui.read('.vscode/agentscope-presets.json'), 'Presets') as Record<string, any>;
  const oldInstruction = 'project/references/missing-workflow.md';
  store.presets['Legacy workflow'].registry.submodules.project.instruction_file = oldInstruction;
  const legacyPreset = JSON.stringify(store);
  await fs.writeFile(path.join(ui.root, '.vscode/agentscope-presets.json'), legacyPreset);
  ui.quickAnswers.push('Legacy workflow');
  ui.warningAnswers.push('Load preset');
  await ui.nativeCommand('activatePreset');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.scope().instruction_file, null);
  assert.equal(readScopeConfiguration(await ui.read(SCOPE_CONFIGURATION_FILE)).submodules.project.instruction_file, null);
  assert.equal(await ui.read('.vscode/agentscope-presets.json'), legacyPreset, 'Keep the saved snapshot while dropping its obsolete active dependency');
  await assert.rejects(fs.stat(path.join(ui.root, oldInstruction)), { code: 'ENOENT' });
});
