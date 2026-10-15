import assert from 'node:assert/strict';
import Module = require('node:module');
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

interface Disposable { dispose(): void }
class Event<T> {
  readonly listeners = new Set<(value: T) => unknown>();
  readonly subscribe = (listener: (value: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  async fire(value: T): Promise<void> { await Promise.all([...this.listeners].map(listener => listener(value))); }
}

class MockUri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  static file(filename: string): MockUri { return new MockUri(path.resolve(filename)); }
  static joinPath(base: MockUri, ...segments: string[]): MockUri { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString(): string { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

class MockWebview {
  html = '';
  options: { enableScripts?: boolean; enableCommandUris?: boolean | string[]; localResourceRoots?: MockUri[] } = {};
  readonly cspSource = 'https://webview.example.test';
  readonly messages = new Event<unknown>();
  readonly posted: unknown[] = [];
  readonly resources = new Map<string, string>();
  readonly onDidReceiveMessage = this.messages.subscribe;
  asWebviewUri(resource: MockUri): { toString(): string } {
    const value = `${this.cspSource}/resource/${encodeURIComponent(resource.fsPath)}`;
    this.resources.set(resource.fsPath, value);
    return { toString: () => value };
  }
  async postMessage(message: unknown): Promise<boolean> { this.posted.push(message); return true; }
}

interface Provider {
  resolveWebviewView(view: unknown): void | Promise<void>;
  refresh(): void | Promise<void>;
  send(message: unknown): Promise<void>;
  dispose(): void;
}
type ProviderConstructor = new (
  extensionUri: MockUri, onMessage: (message: unknown) => Promise<void>, getModel: () => unknown,
) => Provider;

const initialModel = () => ({
  workspaceId: 1, workspace: 'Example workspace', caseSensitive: true,
  trusted: true, busy: false, dirty: false, message: '', projects: [],
});

function loadProvider(t: TestContext, errors: string[] = []): ProviderConstructor {
  const loader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  const filename = require.resolve('../scopeView');
  delete require.cache[filename];
  loader._load = function (name, parent, isMain) {
    return name === 'vscode' ? { Uri: MockUri, window: { showErrorMessage: async (message: string) => { errors.push(message); } } }
      : original.call(this, name, parent, isMain);
  };
  let exported: { ScopeView: ProviderConstructor };
  try { exported = require('../scopeView') as { ScopeView: ProviderConstructor }; }
  finally { loader._load = original; }
  t.after(() => { delete require.cache[filename]; });
  return exported.ScopeView;
}

function mockView() {
  const webview = new MockWebview();
  const disposed = new Event<void>();
  const visibility = new Event<void>();
  return { webview, visible: true, onDidDispose: disposed.subscribe, onDidChangeVisibility: visibility.subscribe, disposed, visibility };
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
}

test('Scope webview enables scripts with media-only resources and no command URI capability', async (t) => {
  const ScopeView = loadProvider(t);
  const extensionUri = MockUri.file(path.join(process.cwd(), 'virtual-extension'));
  const provider = new ScopeView(extensionUri, async () => undefined, initialModel);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts, true);
  assert.ok(view.webview.options.enableCommandUris === undefined || view.webview.options.enableCommandUris === false,
    'No command URI capability should be granted to workspace-controlled messages');
  assert.deepEqual(view.webview.options.localResourceRoots?.map(uri => uri.fsPath), [path.join(extensionUri.fsPath, 'media')]);
});

test('Scope menu offers scoped chat controls and no instruction-policy editors', async (t) => {
  const ScopeView = loadProvider(t);
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async () => undefined, initialModel);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  assert.match(view.webview.html, /data-command="newChat"/);
  assert.match(view.webview.html, /data-command="toggleNewChatPresetPrompt"/);
  assert.match(view.webview.html, /data-command="openConfiguration"/);
  assert.doesNotMatch(view.webview.html, /data-command="(?:openAgents|openAccess)"/);
  assert.doesNotMatch(view.webview.html, /Restore the last valid AGENTS\.md/);
});

test('Scope HTML uses a fresh nonce CSP, external webview assets and a default deny policy', async (t) => {
  const ScopeView = loadProvider(t);
  const extensionUri = MockUri.file(path.join(process.cwd(), 'virtual-extension'));
  const provider = new ScopeView(extensionUri, async () => undefined, initialModel);
  t.after(() => { provider.dispose(); });
  const first = mockView();
  await provider.resolveWebviewView(first);
  const html = first.webview.html;
  const meta = html.match(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i)?.[0];
  assert.ok(meta, 'A CSP meta element must be present');
  const csp = attribute(meta, 'content');
  assert.ok(csp);
  assert.match(csp, /(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/);
  assert.doesNotMatch(csp, /'unsafe-(?:inline|eval)'/);
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce && nonce.length >= 16, 'An unpredictable script nonce must be included in the CSP');
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.equal(attribute(script, 'nonce'), nonce);
    const source = attribute(script, 'src');
    assert.ok(source && [...first.webview.resources.values()].includes(source), 'Script must load through asWebviewUri');
    assert.ok([...first.webview.resources].some(([file, uri]) => uri === source && file.endsWith('.js')));
  }
  const styles = (html.match(/<link\b[^>]*>/gi) ?? []).filter(link => attribute(link, 'rel') === 'stylesheet');
  assert.ok(styles.length > 0);
  for (const stylesheet of styles) {
    const href = attribute(stylesheet, 'href');
    assert.ok(href && [...first.webview.resources].some(([file, uri]) => uri === href && file.endsWith('.css')),
      'Styles must load through asWebviewUri');
  }
  const second = mockView();
  await provider.resolveWebviewView(second);
  assert.equal(first.webview.messages.listeners.size, 0, 'Recreated views must release the previous message listener');
  const otherNonce = /'nonce-([^']+)'/.exec(second.webview.html)?.[1];
  assert.ok(otherNonce && otherNonce !== nonce, 'A recreated view must receive a fresh nonce');
});

test('Workspace names and paths are sent as protocol data instead of inserted into HTML', async (t) => {
  const ScopeView = loadProvider(t);
  const attack = '</script><img src=x onerror="globalThis.compromised=true">';
  const userPath = 'folder/" onclick="alert(1)/<svg onload=alert(1)>';
  let model: unknown = { ...initialModel(), workspace: attack, message: attack, projects: [{ name: attack, path: userPath }] };
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async () => undefined, () => model);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  await provider.refresh();
  const states = view.webview.posted.filter(value => (value as { type?: unknown })?.type === 'state');
  assert.deepEqual(states.at(-1), { type: 'state', state: model }, 'The model must use the protocol state envelope');
  assert.ok(!view.webview.html.includes(attack));
  assert.ok(!view.webview.html.includes(userPath));
  assert.ok(!view.webview.html.includes('globalThis.compromised'));
  assert.ok(view.webview.posted.some(value => JSON.stringify(value).includes(JSON.stringify(attack).slice(1, -1))),
    'Workspace-controlled values must remain available as posted data');
  const originalHTML = view.webview.html;
  model = { ...initialModel(), workspace: 'A changed workspace', dirty: true };
  await provider.refresh();
  assert.equal(view.webview.html, originalHTML, 'Model refresh must not rewrite the HTML shell');
  assert.ok(view.webview.posted.some(value => JSON.stringify(value).includes('A changed workspace')));
});

test('Provider forwards webview messages and sends responses through the message channel', async (t) => {
  const ScopeView = loadProvider(t);
  const received: unknown[] = [];
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async message => { received.push(message); }, initialModel);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  const message = { type: 'setAccess', workspaceId: 1, project: 'project', relative: 'nested/file.md', access: 'write', checked: true };
  await view.webview.messages.fire(message);
  assert.ok(received.includes(message), 'Forward the original message to the host protocol handler');
  const response = { type: 'children', requestId: 'request-1', children: [] };
  await provider.send(response);
  assert.ok(view.webview.posted.includes(response), 'Responses must pass through postMessage rather than HTML');
});

test('The ready handshake sends the current model after the browser loads', async (t) => {
  const ScopeView = loadProvider(t);
  let model = initialModel();
  const received: unknown[] = [];
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async message => { received.push(message); }, () => model);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  model = { ...model, dirty: true, message: 'Changed before the browser was ready' };
  const ready = { type: 'ready' };
  await view.webview.messages.fire(ready);
  assert.deepEqual(view.webview.posted.at(-1), { type: 'state', state: model });
  assert.ok(received.includes(ready));
});

test('Repeated refreshes in one turn publish the latest model once', async (t) => {
  const ScopeView = loadProvider(t);
  let model = initialModel();
  let reads = 0;
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async () => undefined,
    () => { reads++; return model; });
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  const before = view.webview.posted.length;
  const beforeReads = reads;
  for (let index = 0; index < 100; index++) {
    model = { ...initialModel(), message: `Latest change ${index}` };
    provider.refresh();
  }
  await Promise.resolve();
  assert.equal(view.webview.posted.length - before, 1);
  assert.equal(reads - beforeReads, 1, 'Coalesce model construction as well as postMessage calls');
  assert.deepEqual(view.webview.posted.at(-1), { type: 'state', state: model });
});

test('View disposal releases its message listener and detaches the response channel', async (t) => {
  const ScopeView = loadProvider(t);
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async () => undefined, initialModel);
  t.after(() => { provider.dispose(); });
  const view = mockView();
  await provider.resolveWebviewView(view);
  await view.disposed.fire();
  assert.equal(view.webview.messages.listeners.size, 0);
  assert.equal(view.disposed.listeners.size, 0);
  const count = view.webview.posted.length;
  await provider.send({ type: 'state', state: initialModel() });
  assert.equal(view.webview.posted.length, count);
});

test('Disposing the provider removes listeners and prevents stale view responses', async (t) => {
  const ScopeView = loadProvider(t);
  const received: unknown[] = [];
  const provider = new ScopeView(MockUri.file(path.join(process.cwd(), 'virtual-extension')), async message => { received.push(message); }, initialModel);
  const view = mockView();
  await provider.resolveWebviewView(view);
  assert.ok(view.webview.messages.listeners.size > 0);
  provider.dispose();
  assert.equal(view.webview.messages.listeners.size, 0, 'Message subscription must be disposed');
  assert.equal(view.disposed.listeners.size, 0, 'View disposal subscription must be disposed');
  assert.equal(view.visibility.listeners.size, 0, 'View visibility subscription must be disposed');
  await view.webview.messages.fire({ type: 'setAccess' });
  assert.deepEqual(received, []);
  const count = view.webview.posted.length;
  await provider.send({ type: 'children', requestId: 'stale', children: [] });
  assert.equal(view.webview.posted.length, count, 'Disposed views must not receive new responses');
  provider.dispose(); // Disposing more than once must also be harmless.
});
