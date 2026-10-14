import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module = require('node:module');
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as TOML from '@iarna/toml';
import { ACCESS_POLICY_FILE, parseJsoncStrict, readAccessRegistry, readAgentsRegistry, writeAccessFiles } from '../core/registry';
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
          confirmations.push(message); await beforeApplyConfirmation.shift()?.(); return 'Apply';
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
        return { get: (name: string, fallback: unknown) => Object.hasOwn(values, name) ? values[name] : fallback };
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
  return { root, state, scope, projectRow, webview, messages, originals, errors, confirmations, informationMessages, nativeCommand,
    backups, durable, storageControl, restart, dispatch, command, toggle, children, read, inputAnswers, quickAnswers, warningAnswers, configuration, chatgptConfiguration,
    textDocuments, watcherPatterns, activeWatcherPatterns, fireFileEvent, emitFileEvent, waitForState,
    pauseNextLoadedSnapshot, openedDocuments, beforeApplyConfirmation, beforeRestoreConfirmation, quickPickPrompts, previewProviders, executeCalls, closePreviewDocument,
    beforePresetInput, beforePresetConfirmation, beforeBackupSave, openAnswers, removeSelectedWorkspace };
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
  const saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
  assert.deepEqual(saved.submodules.project, originalProject);
  assert.deepEqual(saved.shared_resources.write_paths, ['Instructions/guide.md']);
  const filesystem = (TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).permissions.agentscope.filesystem;
  assert.equal(filesystem[path.join(ui.root, 'Instructions', 'guide.md')], 'write');
  assert.equal(filesystem[path.join(ui.root, 'Instructions')], undefined);
  assert.equal(filesystem[path.join(ui.root, 'project')], 'deny');
});

test('Root files and resource visibility save, reload and restore independently of project settings', async (t) => {
  const ui = await activateInFixture(t);
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
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
  let saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
  assert.deepEqual(saved.shared_resources.write_paths, ['Instructions/guide.md']);
  assert.equal(saved.submodules.project.enabled, false);
  let settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Settings') as Record<string, any>;
  assert.equal(settings['files.exclude'].Instructions, true);
  assert.equal((TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>).default_permissions, 'editing');

  ui.quickAnswers.push('Reading');
  await ui.command('activatePreset');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.state().preset, 'Reading'); assert.equal(ui.state().dirty, false);
  saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
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

test('Untrusted workspaces cannot save, activate or delete presets', async (t) => {
  const ui = await activateInFixture(t, false);
  for (const action of ['savePreset', 'activatePreset', 'deletePreset']) await ui.command(action);
  assert.equal(ui.errors.length, 3); assert.ok(ui.errors.every(error => /Trust the workspace/.test(error)));
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
  assert.equal(filesystem['/mnt/d/MyApps/.agentscope/access.md'], 'read');
  assert.equal(filesystem['/mnt/d/MyApps/project/references'], 'read');
  assert.equal(filesystem['/mnt/d/MyApps/project/drafts'], 'write');
  assert.equal(filesystem[path.join(ui.root, ACCESS_POLICY_FILE)], undefined);
  assert.equal(filesystem[':workspace_roots'], undefined, 'The profile must use only the explicitly selected workspace');
  assert.equal(filesystem['/mnt/d/MyApps'], undefined, 'Mapping does not grant the entire root');
  assert.equal(readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!.submodules.project.path, 'project');
  assert.equal(ui.state().dirty, false);
});

test('Webview commands draft, apply the separate policy and configurations, then restore originals', async (t) => {
  const ui = await activateInFixture(t);
  assert.ok(ui.watcherPatterns.includes(ACCESS_POLICY_FILE), 'Watch external edits to the linked access policy');
  assert.equal(ui.projectRow().enabled, false);
  await ui.command('toggleAccess', 'project');
  await ui.command('toggleVisibility', 'project');
  assert.equal(ui.state().dirty, true);
  assert.equal(ui.projectRow().enabled, true);
  assert.equal(ui.projectRow().hidden, true);
  for (const [file, original] of ui.originals) { assert.equal(await ui.read(file), original, `Draft wrote ${file}`); }

  await ui.command('apply');
  assert.deepEqual(ui.errors, []); assert.equal(ui.confirmations.length, 1);
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(ACCESS_POLICY_FILE);
  assert.equal(readAccessRegistry(agents, access)!.submodules.project.enabled, true);
  assert.deepEqual(readAgentsRegistry(agents), readAgentsRegistry(ui.originals.get('AGENTS.md')!), 'Keep the original inline registry unchanged as historical content');
  assert.equal(readAgentsRegistry(agents)!.submodules.project.enabled, false, 'The retained inline settings cannot override the current linked policy');
  assert.equal(agents.match(/<!-- BEGIN AgentScope access reference -->/g)?.length, 1);
  assert.match(agents, /\.agentscope\/access\.md/);
  assert.match(agents, /sole source of AgentScope access settings/);
  assert.ok(agents.endsWith(ui.originals.get('AGENTS.md')!), 'First Apply must retain every original byte of instructions, legacy rules and inline JSON');
  const settings = parseJsoncStrict(await ui.read('.vscode/settings.json'), 'Test settings') as Record<string, any>;
  assert.equal(settings['files.exclude'].project, true); assert.equal(settings['search.exclude'].project, true);
  assert.equal(settings['files.exclude']['**/.cache'], true); assert.equal(settings['editor.tabSize'], 4);
  const codex = TOML.parse(await ui.read('.codex/config.toml')) as Record<string, any>;
  assert.equal(codex.default_permissions, 'agentscope'); assert.equal(codex.model, 'example-model');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, ACCESS_POLICY_FILE)], 'read');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, 'project', 'references')], 'read');
  assert.equal(codex.permissions.agentscope.filesystem[path.join(ui.root, 'project', 'drafts')], 'write');
  assert.equal(ui.state().dirty, false); assert.ok(ui.backups.has(`backup:${ui.root}`));
  for (const [file, original] of ui.originals) { assert.notEqual(await ui.read(file), original, `${file} did not update`); }

  await ui.command('restore');
  assert.deepEqual(ui.errors, []);
  for (const [file, original] of ui.originals) { assert.equal(await ui.read(file), original, `${file} did not restore`); }
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  assert.equal(ui.projectRow().enabled, false); assert.equal(ui.backups.has(`backup:${ui.root}`), false);
});

test('A second Apply replaces access choices in the sidecar and keeps the main reference stable', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.generateCodexProfile = false;
  const readme = await resourceRow(ui, 'README.md');
  await ui.toggle(readme, 'read', true);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const firstAgents = await ui.read('AGENTS.md');
  const firstAccess = await ui.read(ACCESS_POLICY_FILE);
  const firstSettings = await ui.read('.vscode/settings.json');
  const firstCodex = await ui.read('.codex/config.toml');
  assert.ok(readAccessRegistry(firstAgents, firstAccess)!.shared_resources.read_paths.includes('README.md'));
  assert.ok(firstAgents.endsWith(ui.originals.get('AGENTS.md')!));
  assert.ok(!readAgentsRegistry(firstAgents)!.shared_resources.read_paths.includes('README.md'), 'The old inline registry remains historical rather than being updated');

  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', false);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), firstAgents, 'Permission changes must not rewrite user instructions or the reference');
  assert.equal(firstAgents.match(/<!-- BEGIN AgentScope access reference -->/g)?.length, 1);
  const secondAccess = await ui.read(ACCESS_POLICY_FILE);
  assert.notEqual(secondAccess, firstAccess);
  assert.ok(!readAccessRegistry(firstAgents, secondAccess)!.shared_resources.read_paths.includes('README.md'));
  assert.equal(await ui.read('.vscode/settings.json'), firstSettings);
  assert.equal(await ui.read('.codex/config.toml'), firstCodex);

  await ui.command('restore');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), firstAgents);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), firstAccess, 'Restore the policy from the previous application');
  assert.ok((await resourceRow(ui, 'README.md')).read.checked);
});

test('Custom reference instructions block loading and Apply without changing configuration or the previous backup', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const agents = await ui.read('AGENTS.md');
  const customInstruction = 'Keep every hand-written instruction, including this line.\n';
  const endMarker = '<!-- END AgentScope access reference -->';
  const customized = agents.replace(endMarker, `${customInstruction}${endMarker}`);
  await fs.writeFile(path.join(ui.root, 'AGENTS.md'), customized, 'utf8');
  const saved = new Map<string, string>();
  for (const file of ['AGENTS.md', ACCESS_POLICY_FILE, '.vscode/settings.json', '.codex/config.toml']) {
    saved.set(file, await ui.read(file));
  }
  const backup = structuredClone(ui.backups.get(`backup:${ui.root}`));
  const confirmations = ui.confirmations.length;

  await ui.command('refresh');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /customized.*access reference/i);
  assert.match(ui.errors[0], /Move custom text outside.*restore the original/i);
  assert.equal(ui.state().workspace, path.basename(ui.root), 'A policy failure must retain the selected workspace');
  assert.match(ui.state().configurationError ?? '', /customized.*access reference/i);
  assert.deepEqual(ui.state().projects, []);
  assert.equal(ui.state().resources, undefined);
  await ui.command('apply');
  assert.equal(ui.errors.length, 2);
  assert.equal(ui.confirmations.length, confirmations, 'No rejected operation may reach the Apply confirmation');
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), backup);
  for (const [file, contents] of saved) assert.equal(await ui.read(file), contents, `Custom-reference rejection changed ${file}`);

  // The user repairs the managed reference and keeps their instruction outside it.
  const repaired = agents.replace(endMarker, `${endMarker}\n\n${customInstruction.trimEnd()}`);
  await fs.writeFile(path.join(ui.root, 'AGENTS.md'), repaired, 'utf8');
  await ui.command('refresh');
  assert.equal(ui.errors.length, 2);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.equal(ui.state().configurationError, null);
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  await ui.command('apply');
  assert.equal(ui.errors.length, 2);
  assert.equal(ui.confirmations.length, confirmations + 1);
  assert.equal(await ui.read('AGENTS.md'), repaired, 'A valid Apply must preserve the user instruction outside the managed block');
  assert.ok(readAccessRegistry(repaired, await ui.read(ACCESS_POLICY_FILE))!.shared_resources.read_paths.includes('README.md'));
});

test('Unsaved main or linked policy documents block a sidecar-only Apply before any writes', async (t) => {
  const ui = await activateInFixture(t);
  ui.configuration.generateCodexProfile = false;
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', true);
  await ui.command('apply');
  assert.equal(ui.errors.length, 0);
  const saved = new Map<string, string>();
  for (const file of ['AGENTS.md', ACCESS_POLICY_FILE, '.vscode/settings.json', '.codex/config.toml']) {
    saved.set(file, await ui.read(file));
  }
  const previousBackup = structuredClone(ui.backups.get(`backup:${ui.root}`));
  const confirmationCount = ui.confirmations.length;
  await ui.toggle(await resourceRow(ui, 'README.md'), 'read', false);
  for (const file of ['AGENTS.md', ACCESS_POLICY_FILE]) {
    const filename = path.join(ui.root, file);
    ui.textDocuments.push({ isDirty: true, uri: MockUri.file(filename), fileName: filename });
    const errorCount: number = ui.errors.length;
    await ui.command('apply');
    assert.equal(ui.errors.length, errorCount + 1);
    assert.ok(ui.errors.at(-1)!.includes(path.basename(filename)));
    assert.equal(ui.confirmations.length, confirmationCount);
    assert.equal(ui.state().dirty, true);
    for (const [config, contents] of saved) assert.equal(await ui.read(config), contents, `Unsaved ${file} changed ${config}`);
    assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousBackup);
    ui.textDocuments.length = 0;
  }
  await ui.command('apply');
  assert.equal(ui.confirmations.length, confirmationCount + 1);
  assert.equal(ui.state().dirty, false);
  assert.ok(!readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!.shared_resources.read_paths.includes('README.md'));
});

test('Refreshing a broken linked policy clears stale grants and recovers after explicit repair', async (t) => {
  for (const failure of ['missing', 'invalid'] as const) {
    await t.test(failure, async (caseTest) => {
      const ui = await activateInFixture(caseTest);
      await ui.command('toggleAccess', 'project');
      await ui.command('apply');
      assert.equal(ui.errors.length, 0);
      assert.equal(ui.projectRow().enabled, true);
      const oldEpoch = ui.state().workspaceId;
      const oldScope = structuredClone(ui.scope());
      const validAccess = await ui.read(ACCESS_POLICY_FILE);
      const staleFile = await findPathRow(ui, 'references/nested/paper.md');
      assert.equal(staleFile.read.checked, true);
      const backup = structuredClone(ui.backups.get(`backup:${ui.root}`));
      const confirmations = ui.confirmations.length;
      const saved = new Map<string, string>();
      for (const file of ['AGENTS.md', '.vscode/settings.json', '.codex/config.toml', 'project/references/nested/paper.md']) {
        saved.set(file, await ui.read(file));
      }
      const policyPath = path.join(ui.root, ACCESS_POLICY_FILE);
      if (failure === 'missing') await fs.unlink(policyPath);
      else await fs.writeFile(policyPath, 'This is not a valid AgentScope policy.\n', 'utf8');

      await ui.command('refresh');
      assert.equal(ui.errors.length, 1);
      assert.match(ui.errors[0], /access\.md/);
      const cleared = ui.state();
      assert.equal(cleared.workspace, path.basename(ui.root));
      assert.match(cleared.configurationError ?? '', /access\.md/);
      assert.ok(cleared.workspaceId > oldEpoch, 'Invalidate pending responses and messages from the previous policy');
      assert.deepEqual(cleared.projects, []);
      assert.equal(cleared.resources, undefined);
      assert.equal(cleared.dirty, false);
      assert.equal(cleared.preset, null);

      const oldMessages = [
        { type: 'children', workspaceId: oldEpoch, name: 'project', relative: 'references', requestId: 424242 },
        { type: 'toggle', workspaceId: oldEpoch, name: staleFile.name, relative: staleFile.relative,
          access: 'write', checked: true, directory: staleFile.directory },
        { type: 'command', workspaceId: oldEpoch, command: 'apply' },
        { type: 'command', workspaceId: cleared.workspaceId, command: 'apply' },
      ];
      for (const message of oldMessages) {
        const previousErrors: number = ui.errors.length;
        await ui.dispatch(message);
        assert.equal(ui.errors.length, previousErrors + 1);
        assert.match(ui.errors.at(-1)!, /workspace changed|access\.md|configuration/i);
        assert.equal(ui.state().workspace, path.basename(ui.root));
        assert.deepEqual(ui.state().projects, []);
      }
      assert.equal(ui.messages.some(message => message.type === 'children' && message.requestId === 424242), false);
      assert.equal(ui.confirmations.length, confirmations, 'Rejected Apply must not reach its confirmation or backup');
      assert.deepEqual(ui.backups.get(`backup:${ui.root}`), backup);
      for (const [file, contents] of saved) assert.equal(await ui.read(file), contents, `A stale message changed ${file}`);
      if (failure === 'missing') await assert.rejects(fs.stat(policyPath), { code: 'ENOENT' });
      else assert.equal(await ui.read(ACCESS_POLICY_FILE), 'This is not a valid AgentScope policy.\n');

      // Repair is explicit; Refresh must remain usable from the cleared panel.
      const errorCount: number = ui.errors.length;
      const watchedPolicyCount = ui.watcherPatterns.filter(pattern => pattern === ACCESS_POLICY_FILE).length;
      await fs.writeFile(policyPath, validAccess, 'utf8');
      await ui.command('refresh');
      assert.equal(ui.errors.length, errorCount);
      assert.equal(ui.state().workspace, path.basename(ui.root));
      assert.equal(ui.state().configurationError, null);
      assert.ok(ui.state().workspaceId > cleared.workspaceId);
      assert.deepEqual(ui.scope(), oldScope, 'Reload the repaired registry rather than the failed or stale policy');
      assert.equal((await findPathRow(ui, staleFile.relative)).read.checked, true);
      assert.equal(ui.watcherPatterns.filter(pattern => pattern === ACCESS_POLICY_FILE).length, watchedPolicyCount,
        'Keep the same watchers active across policy failures and successful reloads');
      assert.equal(ui.activeWatcherPatterns().filter(pattern => pattern === ACCESS_POLICY_FILE).length, 1);
      assert.equal(await ui.read(ACCESS_POLICY_FILE), validAccess);
      assert.equal(ui.confirmations.length, confirmations);
      assert.deepEqual(ui.backups.get(`backup:${ui.root}`), backup);
      for (const [file, contents] of saved) assert.equal(await ui.read(file), contents);
    });
  }
});

test('Deleting AGENTS.md retains the selected workspace and exact linked scopes until Apply recreates the reference', async (t) => {
  const ui = await activateInFixture(t, true, false, {
    enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [],
  });
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const savedScope = structuredClone(ui.scope());
  const access = await ui.read(ACCESS_POLICY_FILE);
  const settings = await ui.read('.vscode/settings.json');
  const codex = await ui.read('.codex/config.toml');
  const oldEpoch = ui.state().workspaceId;
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await ui.emitFileEvent('AGENTS.md', 'delete');

  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.ok(ui.state().workspaceId > oldEpoch);
  assert.equal(ui.state().configurationError, null);
  assert.deepEqual(ui.scope(), savedScope);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).read.checked, true);
  assert.equal((await findPathRow(ui, 'references/nested/sibling.md')).read.checked, false);
  assert.equal(ui.state().dirty, false);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });

  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const agents = await ui.read('AGENTS.md');
  assert.equal(agents.match(/<!-- BEGIN AgentScope access reference -->/g)?.length, 1);
  assert.match(agents, /\.agentscope\/access\.md/);
  assert.doesNotMatch(agents, /```json|Keep my editorial rules/);
  assert.deepEqual(readAccessRegistry(agents, await ui.read(ACCESS_POLICY_FILE))!.submodules.project, savedScope);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), access, 'Recreating the reference must preserve the existing policy exactly');
  assert.equal(await ui.read('.vscode/settings.json'), settings);
  assert.equal(await ui.read('.codex/config.toml'), codex);
  const recreated = (ui.backups.get(`backup:${ui.root}`) as Array<{ path: string; before: string | null }>);
  assert.deepEqual(recreated.map(change => path.relative(ui.root, change.path)), ['AGENTS.md']);
  assert.equal(recreated[0].before, null, 'The transaction and Restore must use the known absence of AGENTS.md');
});

test('A newly created AGENTS.md during Apply cannot be overwritten by a plan based on its absence', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const access = await ui.read(ACCESS_POLICY_FILE);
  const previousBackup = structuredClone(ui.backups.get(`backup:${ui.root}`));
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await ui.emitFileEvent('AGENTS.md', 'delete');
  const userInstructions = '# My new instructions\n\nKeep this newly created file.\n';
  ui.beforeApplyConfirmation.push(async () => {
    await fs.writeFile(path.join(ui.root, 'AGENTS.md'), userInstructions, 'utf8');
  });
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /changed|conflict/i);
  assert.match(ui.errors[0], /AGENTS\.md/);
  assert.equal(await ui.read('AGENTS.md'), userInstructions);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousBackup);
});

test('Policy watcher failures keep the workspace selected and automatically recover after repair', async (t) => {
  for (const failure of ['missing', 'invalid'] as const) {
    await t.test(failure, async caseTest => {
      const ui = await activateInFixture(caseTest, true, false, {
        enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [],
      });
      await ui.command('apply');
      const scope = structuredClone(ui.scope());
      const access = await ui.read(ACCESS_POLICY_FILE);
      const agents = await ui.read('AGENTS.md');
      const previousBackup = structuredClone(ui.backups.get(`backup:${ui.root}`));
      const confirmations = ui.confirmations.length;
      const policyPath = path.join(ui.root, ACCESS_POLICY_FILE);
      if (failure === 'missing') await fs.unlink(policyPath);
      else await fs.writeFile(policyPath, 'Invalid linked policy.\n', 'utf8');
      await ui.emitFileEvent(ACCESS_POLICY_FILE, failure === 'missing' ? 'delete' : 'change');

      assert.equal(ui.errors.length, 0, 'Background policy errors are shown in the panel without popups');
      assert.equal(ui.state().workspace, path.basename(ui.root));
      assert.match(ui.state().configurationError ?? '', /access\.md/);
      assert.equal(ui.state().message, ui.state().configurationError, 'Show the actual configuration error in the retained workspace');
      assert.deepEqual(ui.state().projects, []);
      assert.equal(ui.state().resources, undefined);
      assert.equal(ui.state().dirty, false);
      assert.equal(ui.activeWatcherPatterns().filter(pattern => pattern === ACCESS_POLICY_FILE).length, 1);
      await ui.command('openAccess');
      assert.equal(ui.openedDocuments.at(-1)?.fsPath, policyPath, 'The policy repair command must work without valid scope state');
      await ui.command('openAgents');
      assert.equal(ui.openedDocuments.at(-1)?.fsPath, path.join(ui.root, 'AGENTS.md'));
      await ui.command('openCodex');
      assert.equal(ui.openedDocuments.at(-1)?.fsPath, path.join(ui.root, '.codex', 'config.toml'));
      assert.equal(ui.errors.length, 0);
      await ui.command('apply');
      assert.equal(ui.errors.length, 1);
      assert.equal(ui.confirmations.length, confirmations);
      assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousBackup);
      assert.equal(await ui.read('AGENTS.md'), agents);
      if (failure === 'missing') await assert.rejects(fs.stat(policyPath), { code: 'ENOENT' });
      else assert.equal(await ui.read(ACCESS_POLICY_FILE), 'Invalid linked policy.\n');

      await fs.writeFile(policyPath, access, 'utf8');
      await ui.emitFileEvent(ACCESS_POLICY_FILE, failure === 'missing' ? 'create' : 'change');
      assert.equal(ui.errors.length, 1);
      assert.equal(ui.state().workspace, path.basename(ui.root));
      assert.equal(ui.state().configurationError, null);
      assert.deepEqual(ui.scope(), scope);
      assert.equal((await findPathRow(ui, 'references/nested/paper.md')).read.checked, true);
      assert.equal((await findPathRow(ui, 'references/nested/sibling.md')).read.checked, false);
      assert.equal(ui.activeWatcherPatterns().filter(pattern => pattern === ACCESS_POLICY_FILE).length, 1);
      assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousBackup);
      assert.equal(await ui.read('AGENTS.md'), agents);
      assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
    });
  }
});

test('An initially missing access policy stays inline without startup notifications or automatic repairs', async (t) => {
  const expected = registry({ project: project({ enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [] }) });
  const files = writeAccessFiles(policy(expected), null, expected);
  const ui = await activateInFixture(t, true, false, {}, async root => {
    await fs.mkdir(path.join(root, '.agentscope'));
    await fs.writeFile(path.join(root, 'AGENTS.md'), files.agents, 'utf8');
  });
  assert.equal(ui.errors.length, 0);
  assert.deepEqual(ui.informationMessages, []);
  assert.deepEqual(ui.quickPickPrompts, []);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.match(ui.state().configurationError ?? '', /access\.md/);
  assert.deepEqual(ui.state().projects, []);
  assert.equal(ui.state().resources, undefined);
  assert.equal(ui.activeWatcherPatterns().length, 5, 'Initial policy loading failures must leave repair events subscribed');
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });

  await ui.nativeCommand('refresh');
  assert.equal(ui.errors.length, 1, 'An explicit failed Refresh reports its error once');
  assert.match(ui.errors[0], /access\.md/);
  assert.equal(ui.state().configurationError !== null, true);
  assert.equal(await ui.read('AGENTS.md'), files.agents);
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });

  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), files.access, 'utf8');
  await ui.emitFileEvent(ACCESS_POLICY_FILE, 'create');
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.state().configurationError, null);
  assert.deepEqual(ui.scope(), expected.submodules.project);
  assert.equal((await findPathRow(ui, 'references/nested/sibling.md')).read.checked, false);
  assert.equal(await ui.read('AGENTS.md'), files.agents);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), files.access);
  assert.equal(ui.confirmations.length, 0);
  assert.equal(ui.backups.size, 0);
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });

  await ui.nativeCommand('selectWorkspace');
  assert.equal(ui.quickPickPrompts.length, 1);
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.equal(ui.state().projects.length, 1);
  assert.deepEqual(ui.errors, []);
});

test('Delete and create events arriving during a workspace load queue a fresh snapshot instead of losing the latest policy', async (t) => {
  const ui = await activateInFixture(t, true, false, {
    enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [],
  });
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const savedScope = structuredClone(ui.scope());
  const access = await ui.read(ACCESS_POLICY_FILE);
  const agents = await ui.read('AGENTS.md');
  const oldEpoch = ui.state().workspaceId;
  const paused = ui.pauseNextLoadedSnapshot();
  ui.fireFileEvent('AGENTS.md', 'change');
  await paused.started;
  assert.equal(ui.state().busy, true);

  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  ui.fireFileEvent('AGENTS.md', 'delete');
  await fs.unlink(path.join(ui.root, ACCESS_POLICY_FILE));
  ui.fireFileEvent(ACCESS_POLICY_FILE, 'delete');
  await fs.writeFile(path.join(ui.root, 'AGENTS.md'), agents, 'utf8');
  ui.fireFileEvent('AGENTS.md', 'create');
  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), 'Latest invalid policy.\n', 'utf8');
  ui.fireFileEvent(ACCESS_POLICY_FILE, 'create');
  const failed = ui.waitForState(model => !model.busy && model.workspaceId > oldEpoch && !!model.configurationError,
    'Queued watcher must reread the latest invalid policy');
  paused.release();
  await failed;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ui.errors.length, 0, 'Queued background reload errors remain inline');
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.deepEqual(ui.state().projects, []);
  assert.equal(ui.state().resources, undefined);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), 'Latest invalid policy.\n');

  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), access, 'utf8');
  await ui.emitFileEvent(ACCESS_POLICY_FILE, 'change');
  assert.equal(ui.state().configurationError, null);
  assert.deepEqual(ui.scope(), savedScope);
  assert.equal(ui.activeWatcherPatterns().length, 5, 'Retain one active subscription per configuration input');
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
  const saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!.submodules.project;
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
  const saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!.submodules.project;
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

test('A successful Apply checkpoints exact policy bytes outside the workspace and survives restart with both files deleted', async (t) => {
  const ui = await activateInFixture(t, true, false, {
    enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [],
  });
  assert.equal(ui.state().recoveryAvailable, false, 'Legacy instructions alone are not a complete saved policy pair');
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(ACCESS_POLICY_FILE);
  const selected = structuredClone(ui.scope());
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  const saved = validateCheckpoint(checkpoint, ui.root);
  assert.equal(saved.agents, agents); assert.equal(saved.access, access);
  assert.equal(ui.state().recoveryAvailable, true);

  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await fs.unlink(path.join(ui.root, ACCESS_POLICY_FILE));
  ui.backups.clear();
  await ui.restart();
  assert.equal(ui.state().workspace, path.basename(ui.root));
  assert.equal(ui.state().recoveryAvailable, true, 'Recovery must use persistent extension storage even when Undo and both files are gone');
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint, 'Empty default configuration cannot replace a complete checkpoint');
  assert.ok(ui.state().projects.every(row => !row.enabled), 'Deletion must never silently reactivate the saved access');
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });

  await ui.command('recover');
  assert.deepEqual(ui.errors, []);
  assert.equal(await ui.read('AGENTS.md'), agents);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
  assert.deepEqual(ui.scope(), selected);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).read.checked, true);
  assert.equal((await findPathRow(ui, 'references/nested/sibling.md')).read.checked, false);
  const undo = ui.backups.get(`backup:${ui.root}`) as Array<{ path: string; before: string | null }>;
  assert.equal(undo.length, 2); assert.ok(undo.every(change => change.before === null));
});

test('Recovery restores a corrupt policy from an error panel and Undo returns the exact corrupt bytes', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  await ui.command('apply');
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(ACCESS_POLICY_FILE);
  const settings = await ui.read('.vscode/settings.json');
  const codex = await ui.read('.codex/config.toml');
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  const corrupt = 'Broken access settings: { definitely not a registry\n';
  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), corrupt, 'utf8');
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  assert.equal(ui.state().recoveryAvailable, true);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint, 'Loading corrupt files cannot replace the last valid snapshot');
  assert.equal(ui.errors.length, 1);

  await ui.command('recover');
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.state().configurationError, null);
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
  assert.equal(await ui.read('.vscode/settings.json'), settings); assert.equal(await ui.read('.codex/config.toml'), codex);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).write.checked, true);

  await ui.command('restore');
  assert.equal(await ui.read(ACCESS_POLICY_FILE), corrupt, 'Undo Recovery must preserve the overwritten corrupt file for review');
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
  for (const file of ['AGENTS.md', ACCESS_POLICY_FILE, '.vscode/settings.json', '.codex/config.toml']) files.set(file, await ui.read(file));
  await ui.toggle(await resourceRow(ui, 'README.md'), 'write', true);
  ui.storageControl.failCheckpointSave = true;
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /recovery-checkpoint storage failure/);
  assert.equal(ui.state().dirty, true);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
  for (const [file, text] of files) assert.equal(await ui.read(file), text, `Failed checkpoint persistence changed ${file}`);
});

test('Recovery respects unsaved policy editors and cannot write before its Undo backup is persisted', async (t) => {
  const savedRegistry = registry({ project: project({ enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [] }) });
  const saved = writeAccessFiles(policy(savedRegistry), null, savedRegistry);
  for (const reason of ['unsaved editor', 'backup storage failure'] as const) await t.test(reason, async caseTest => {
    const ui = await activateInFixture(caseTest, true, reason === 'backup storage failure', {}, async root => {
      await fs.mkdir(path.join(root, '.agentscope'));
      await fs.writeFile(path.join(root, 'AGENTS.md'), saved.agents, 'utf8');
      await fs.writeFile(path.join(root, ACCESS_POLICY_FILE), saved.access, 'utf8');
    });
    assert.deepEqual(ui.errors, []); assert.equal(ui.state().recoveryAvailable, true, 'A complete valid initial load is checkpointed');
    const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
    const corrupt = 'Damaged policy contents must survive failed recovery.\n';
    await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), corrupt, 'utf8');
    await ui.command('refresh');
    assert.equal(ui.errors.length, 1);
    if (reason === 'unsaved editor') {
      const filename = path.join(ui.root, 'AGENTS.md');
      ui.textDocuments.push({ isDirty: true, uri: MockUri.file(filename), fileName: filename });
    }
    await ui.command('recover');
    assert.equal(ui.errors.length, 2);
    assert.match(ui.errors.at(-1)!, reason === 'unsaved editor' ? /AGENTS\.md|unsaved|save/i : /workspace-state storage failure/);
    assert.equal(await ui.read('AGENTS.md'), saved.agents);
    assert.equal(await ui.read(ACCESS_POLICY_FILE), corrupt);
    assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
    assert.equal(ui.backups.size, 0);
  });
});

test('A full previous Apply backup can bootstrap durable recovery while an incomplete backup cannot', async (t) => {
  const savedRegistry = registry({ project: project({ enabled: true, read_paths: ['references/nested/paper.md'], write_paths: [] }) });
  const saved = writeAccessFiles(policy(savedRegistry), null, savedRegistry);
  for (const fullPair of [true, false]) await t.test(fullPair ? 'complete' : 'incomplete', async caseTest => {
    const ui = await activateInFixture(caseTest, true, false, {}, async root => {
      await fs.unlink(path.join(root, 'AGENTS.md'));
    }, { initialBackup: root => [
      { path: path.join(root, 'AGENTS.md'), before: null, after: saved.agents },
      ...(fullPair ? [{ path: path.join(root, ACCESS_POLICY_FILE), before: null, after: saved.access }] : []),
    ] });
    assert.equal(ui.state().recoveryAvailable, fullPair);
    assert.equal(ui.durable.has(checkpointKey(ui.root)), fullPair);
    if (!fullPair) {
      await ui.command('recover');
      assert.equal(ui.errors.length, 1);
      await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
      return;
    }
    await ui.command('recover');
    assert.deepEqual(ui.errors, []);
    assert.equal(await ui.read('AGENTS.md'), saved.agents); assert.equal(await ui.read(ACCESS_POLICY_FILE), saved.access);
    assert.deepEqual(ui.scope(), savedRegistry.submodules.project);
  });
});

test('Corrupt durable checkpoints remain unavailable and cannot write policy files', async (t) => {
  const ui = await activateInFixture(t, true, false, {}, async root => {
    await fs.unlink(path.join(root, 'AGENTS.md'));
  }, { initialCheckpoint: root => ({ version: 1, root, agents: 'corrupt', access: 'corrupt', savedAt: new Date().toISOString() }) });
  assert.equal(ui.state().recoveryAvailable, false);
  const originalSettings = await ui.read('.vscode/settings.json');
  await ui.command('recover');
  assert.ok(ui.errors.some(message => /checkpoint|saved|recover/i.test(message)));
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  assert.equal(await ui.read('.vscode/settings.json'), originalSettings);
});

test('Recovery and reconfiguration reject stale panel messages and Restricted Mode', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const oldEpoch = ui.state().workspaceId;
  await ui.command('refresh');
  const files = new Map<string, string>();
  for (const file of ['AGENTS.md', ACCESS_POLICY_FILE, '.vscode/settings.json', '.codex/config.toml']) files.set(file, await ui.read(file));
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
  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), broken, 'utf8');
  await ui.command('refresh');
  assert.equal(ui.errors.length, 1); assert.ok(ui.state().configurationError);
  await ui.command('reconfigure');
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.state().configurationError, null); assert.equal(ui.state().dirty, true);
  assert.equal(ui.scope().enabled, false);
  assert.deepEqual(ui.scope().read_paths, []); assert.deepEqual(ui.scope().write_paths, []);
  assert.deepEqual(ui.state().resources!.scope!.read_paths, []); assert.deepEqual(ui.state().resources!.scope!.write_paths, []);
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(ACCESS_POLICY_FILE), broken, 'Reconfigure only creates a draft');

  const selectedPath = 'references/nested/sibling.md';
  await ui.toggle(await findPathRow(ui, selectedPath), 'write', true);
  await ui.command('apply');
  assert.equal(ui.errors.length, 1); assert.equal(ui.state().configurationError, null);
  assert.ok((await ui.read('AGENTS.md')).includes(userText));
  const selected = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
  assert.deepEqual(selected.submodules.project.write_paths, [selectedPath]);
  assert.deepEqual(selected.submodules.project.read_paths, []); assert.deepEqual(selected.shared_resources.read_paths, []);
  assert.equal((await findPathRow(ui, 'references/nested/paper.md')).read.checked, false);
  assert.equal((await findPathRow(ui, selectedPath)).write.checked, true);
  assert.equal(ui.state().recoveryAvailable, true);
  await ui.command('restore');
  assert.equal(await ui.read('AGENTS.md'), agents); assert.equal(await ui.read(ACCESS_POLICY_FILE), broken);
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
  const saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
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
  const access = await ui.read(ACCESS_POLICY_FILE);
  const main = await ui.read('AGENTS.md');
  await ui.toggle(await resourceRow(ui, 'README.md'), 'write', true);
  ui.storageControl.failPendingCleanup = true;
  ui.beforeApplyConfirmation.push(() => fs.writeFile(path.join(ui.root, 'AGENTS.md'), main + '\nPreserve my competing edit.\n', 'utf8'));
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /changed.*refresh.*cleanup also failed/is);
  assert.deepEqual(ui.durable.get(savedKey), good);
  assert.ok(ui.durable.has(`${savedKey}.pending`), 'Prepared data remains distinguishable from committed data');
  assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
  assert.equal(await ui.read('AGENTS.md'), main + '\nPreserve my competing edit.\n');
});

test('An unfinished staged Apply cannot bootstrap recovery from its pre-write Undo record', async (t) => {
  const value = registry({ project: project({ enabled: true, restrict_paths: false }) });
  const saved = writeAccessFiles(policy(value), null, value);
  const ui = await activateInFixture(t, true, false, {}, root => fs.unlink(path.join(root, 'AGENTS.md')), {
    initialPending: root => ({ version: 1, root, agents: saved.agents, access: saved.access, savedAt: new Date().toISOString() }),
    initialBackup: root => [
      { path: path.join(root, 'AGENTS.md'), before: null, after: saved.agents },
      { path: path.join(root, ACCESS_POLICY_FILE), before: null, after: saved.access },
    ],
  });
  assert.equal(ui.state().recoveryAvailable, false);
  assert.equal(ui.durable.has(checkpointKey(ui.root)), false);
  await ui.restart();
  assert.equal(ui.state().recoveryAvailable, false);
  await ui.command('recover');
  assert.equal(ui.errors.length, 1);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('Recovery locks registered commands before awaiting policy reads', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), 'Corrupt policy\n', 'utf8');
  await ui.command('refresh');
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const readFile = fs.readFile.bind(fs);
  let intercepted = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (!intercepted && String(args[0]) === path.join(ui.root, 'AGENTS.md')) {
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

test('An unchanged Apply still refuses externally deleted policy inputs', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const checkpoint = structuredClone(ui.durable.get(checkpointKey(ui.root)));
  await fs.unlink(path.join(ui.root, 'AGENTS.md'));
  await ui.command('apply');
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /input changed.*refresh/i);
  assert.deepEqual(ui.durable.get(checkpointKey(ui.root)), checkpoint);
  await assert.rejects(fs.stat(path.join(ui.root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('Recovery remains undoable from a configuration error panel when unrelated settings are malformed', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const savedPolicy = await ui.read(ACCESS_POLICY_FILE);
  const corruptedPolicy = 'Corrupted policy text must be preserved for Undo.\n';
  const corruptedSettings = '{ malformed editor configuration';
  await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), corruptedPolicy);
  await fs.writeFile(path.join(ui.root, '.vscode/settings.json'), corruptedSettings);
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  await ui.command('recover');
  assert.equal(await ui.read(ACCESS_POLICY_FILE), savedPolicy);
  assert.match(ui.state().configurationError!, /invalid JSON\/JSONC/);
  const errorCount = ui.errors.length;

  await ui.command('restore');
  assert.equal(await ui.read(ACCESS_POLICY_FILE), corruptedPolicy, 'Restore must use the selected root while loading remains blocked');
  assert.equal(await ui.read('.vscode/settings.json'), corruptedSettings, 'Undo recovery must not repair unrelated settings');
  assert.equal(ui.backups.has(`backup:${ui.root}`), false);
  assert.ok(ui.state().configurationError, 'The faithfully restored corrupt policy remains a configuration error');
  assert.ok(ui.errors.length <= errorCount + 1, 'Only reloading the restored corrupt configuration may report an error');
});

test('Restore refuses corrupt, duplicate or unrelated Undo targets without changing any files', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const agents = await ui.read('AGENTS.md');
  const access = await ui.read(ACCESS_POLICY_FILE);
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
    assert.equal(await ui.read(ACCESS_POLICY_FILE), access);
    assert.equal(await ui.read('README.md'), readme);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'Other workspace contents.\n');
  }
});

test('Apply and Restore recheck unsaved editors after their native confirmation dialogs', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const policy = await ui.read(ACCESS_POLICY_FILE);
  const filename = path.join(ui.root, ACCESS_POLICY_FILE);
  const editor = { isDirty: false, uri: MockUri.file(filename), fileName: filename };
  ui.textDocuments.push(editor);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  ui.beforeApplyConfirmation.push(async () => { editor.isDirty = true; });
  await ui.command('apply');
  assert.equal(await ui.read(ACCESS_POLICY_FILE), policy);
  assert.match(ui.errors.at(-1)!, /unsaved|save or discard/i);
  editor.isDirty = false;
  await ui.command('apply');
  const applied = await ui.read(ACCESS_POLICY_FILE);
  ui.beforeRestoreConfirmation.push(async () => { editor.isDirty = true; });
  const errors = ui.errors.length;
  await ui.nativeCommand('restore');
  assert.equal(ui.errors.length, errors + 1);
  assert.match(ui.errors.at(-1)!, /unsaved|save or discard/i);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), applied);
  assert.ok(ui.backups.has(`backup:${ui.root}`));
});

test('Preview shows the current and proposed access policy for a selected leaf without saving any files', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const before = await ui.read(ACCESS_POLICY_FILE);
  const main = await ui.read('AGENTS.md');
  const backup = structuredClone(ui.backups.get(`backup:${ui.root}`));
  const leaf = 'references/nested/paper.md';
  await ui.toggle(await findPathRow(ui, leaf), 'write', true);
  ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => path.normalize(item.label) === path.normalize(ACCESS_POLICY_FILE)));
  await ui.command('preview');

  assert.deepEqual(ui.errors, []);
  const diff = ui.executeCalls.find(call => call.name === 'vscode.diff');
  assert.ok(diff, 'Selecting a pending file must open a VS Code diff');
  const content = ui.previewProviders.get('agentscope-preview');
  assert.ok(content);
  const [beforeUri, afterUri, title] = diff.args as [MockUri, MockUri, string];
  assert.equal(content.provideTextDocumentContent(beforeUri), before);
  const proposed = content.provideTextDocumentContent(afterUri);
  const proposedRegistry = readAccessRegistry(main, proposed)!;
  assert.deepEqual(proposedRegistry.submodules.project.write_paths, [leaf]);
  assert.match(title, /AgentScope:/);
  const prompt = ui.quickPickPrompts.at(-1)!;
  assert.match(prompt.options.title, /Preview pending/);
  assert.match(prompt.options.placeHolder, /current.*left.*proposed.*right/i);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), before, 'Preview is read-only');
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  assert.equal(ui.state().dirty, true);
  assert.equal(ui.backups.size, 0);
  assert.deepEqual(ui.errors, []);
});

test('A native Preview keeps its selected workspace locked while choosing a pending file', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  const original = await ui.read(ACCESS_POLICY_FILE);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  ui.quickAnswers.push(async (items: Array<{ label: string }>) => {
    enter(); await held; return items.find(item => path.normalize(item.label) === path.normalize(ACCESS_POLICY_FILE));
  });
  const previewing = ui.nativeCommand('preview');
  await entered;
  try {
    assert.equal(ui.state().busy, true);
    for (const action of ['selectWorkspace', 'apply', 'restore']) await ui.nativeCommand(action);
    assert.equal(ui.errors.length, 3);
    assert.ok(ui.errors.every(error => /Wait for the current|Wait for.*selection/i.test(error)));
    assert.equal(await ui.read(ACCESS_POLICY_FILE), original);
  } finally { release(); await previewing; }
  assert.equal(ui.state().busy, false);
  assert.equal(ui.executeCalls.filter(call => call.name === 'vscode.diff').length, 1);
  assert.equal(ui.state().dirty, true);
});

test('Closing a Preview document releases its stored snapshot without changing other open previews', async (t) => {
  const ui = await activateInFixture(t);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  ui.quickAnswers.push((items: Array<{ label: string }>) => items.find(item => path.normalize(item.label) === path.normalize(ACCESS_POLICY_FILE)));
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
  const saved = await ui.read(ACCESS_POLICY_FILE);
  const filename = path.join(ui.root, ACCESS_POLICY_FILE);
  const editor = { isDirty: true, uri: MockUri.file(filename.toLowerCase()), fileName: filename };
  assert.notEqual(editor.uri.fsPath, filename, 'The fixture exercises Windows canonical URI casing');
  ui.textDocuments.push(editor);
  await ui.toggle(await findPathRow(ui, 'references/nested/paper.md'), 'write', true);
  await ui.command('apply');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), saved);

  editor.isDirty = false;
  await ui.command('apply');
  const applied = await ui.read(ACCESS_POLICY_FILE);
  editor.isDirty = true;
  await ui.nativeCommand('restore');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), applied);

  editor.isDirty = false;
  const corrupted = 'Policy bytes that must survive an unsaved-editor conflict.\n';
  await fs.writeFile(filename, corrupted);
  await ui.command('refresh');
  assert.ok(ui.state().configurationError);
  editor.isDirty = true;
  await ui.command('recover');
  assert.match(ui.errors.at(-1)!, /save or discard/i);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), corrupted);
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
  assert.ok(read.includes('.agentscope'));
  assert.ok(!read.includes('.') && !read.some(relative => relative === 'project' || relative.startsWith('project/')));
  assert.deepEqual(ui.scope(), beforeProject);
  await ui.toggle(ui.state().resources!, 'write', true);
  assert.equal(ui.state().resources?.write.checked, true);
  assert.equal(ui.state().resources?.read.checked, true);
  assert.ok(!ui.state().resources!.scope!.write_paths.includes('.'));
  await ui.command('apply');
  assert.deepEqual(ui.errors, []);
  const persisted = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE))!;
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
    ui.fireFileEvent('AGENTS.md');
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('An unchanged Recovery preserves the previous Undo journal, explains the no-op and still checks for competing edits', async (t) => {
  const ui = await activateInFixture(t);
  await ui.command('apply');
  const previousUndo = structuredClone(ui.backups.get(`backup:${ui.root}`));
  assert.ok(Array.isArray(previousUndo) && previousUndo.length > 0);
  const agents = await ui.read('AGENTS.md');
  const policy = await ui.read(ACCESS_POLICY_FILE);
  await ui.command('recover');
  assert.deepEqual(ui.errors, []);
  assert.deepEqual(ui.backups.get(`backup:${ui.root}`), previousUndo);
  assert.equal(await ui.read('AGENTS.md'), agents);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), policy);
  const message = ui.informationMessages.at(-1)!;
  assert.match(message, /saved policy.*already on disk/i);
  assert.match(message, /no files changed/i);
  assert.doesNotMatch(message, /Restore.*undo.*recovery/i);

  const target = path.join(ui.root, ACCESS_POLICY_FILE);
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

test('Preset Save and Delete refuse dirty editors before dialogs and after their confirmations', async (t) => {
  const ui = await activateInFixture(t);
  const target = path.join(ui.root, '.vscode', 'agentscope-presets.json');
  ui.inputAnswers.push('Existing');
  await ui.command('savePreset');
  const before = await ui.read('.vscode/agentscope-presets.json');
  const editor = { isDirty: true, uri: MockUri.file(process.platform === 'win32' ? target.toUpperCase() : target), fileName: target };
  ui.textDocuments.push(editor);
  await ui.nativeCommand('savePreset');
  await ui.nativeCommand('deletePreset');
  assert.equal(ui.errors.length, 2);
  assert.ok(ui.errors.every(error => /Save or discard.*agentscope-presets/i.test(error)));
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
  assert.equal(ui.errors.length, 4);
});

test('File changes during preset input are reconciled after both saving and cancellation', async (t) => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? 'cancelled input' : 'saved preset', async (t) => {
      const ui = await activateInFixture(t);
      const epoch = ui.state().workspaceId;
      const damaged = '```json\n{"submodules":\n```\n';
      if (!cancelled) ui.inputAnswers.push('Writing');
      ui.beforePresetInput.push(async () => {
        assert.equal(ui.state().busy, true);
        await fs.writeFile(path.join(ui.root, 'AGENTS.md'), damaged);
        ui.fireFileEvent('AGENTS.md');
        assert.equal(ui.state().workspaceId, epoch);
      });
      await ui.nativeCommand('savePreset');
      await ui.waitForState(model => !!model.configurationError && !model.busy, 'Queued invalid policy reload');
      assert.equal(ui.state().projects.length, 0);
      assert.equal(await ui.read('AGENTS.md'), damaged);
      assert.ok(ui.state().workspaceId > epoch);
    });
  }
});

test('A policy event after the post-Apply snapshot is reloaded before the panel stays idle', async (t) => {
  const ui = await activateInFixture(t);
  const gate = ui.pauseNextLoadedSnapshot();
  const applying = ui.nativeCommand('apply');
  await gate.started;
  const damaged = 'Damaged sidecar after the loaded snapshot.\n';
  try {
    await fs.writeFile(path.join(ui.root, ACCESS_POLICY_FILE), damaged);
    ui.fireFileEvent(ACCESS_POLICY_FILE);
  } finally { gate.release(); }
  await applying;
  await ui.waitForState(model => !!model.configurationError && !model.busy, 'Late post-Apply policy error');
  assert.equal(ui.state().projects.length, 0);
  assert.equal(await ui.read(ACCESS_POLICY_FILE), damaged);
});

test('A queued own Apply event preserves the applied preset when its choices still match', async (t) => {
  const ui = await activateInFixture(t);
  ui.inputAnswers.push('Writing');
  await ui.command('savePreset');
  const gate = ui.pauseNextLoadedSnapshot();
  const applying = ui.nativeCommand('apply');
  await gate.started;
  const epoch = ui.state().workspaceId;
  try { ui.fireFileEvent(ACCESS_POLICY_FILE); } finally { gate.release(); }
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
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
  await assert.rejects(fs.stat(path.join(ui.root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
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
  const saved = readAccessRegistry(await ui.read('AGENTS.md'), await ui.read(ACCESS_POLICY_FILE));
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
