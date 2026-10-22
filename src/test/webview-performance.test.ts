import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';

interface Metrics { created: number; listeners: number; inserted: number; removed: number; projectSearches: number }
type Handler = (event: any) => void;

/** The browser boundary is mocked; the shipped webview script and its handlers run unchanged. */
function browser() {
  const metrics: Metrics = { created: 0, listeners: 0, inserted: 0, removed: 0, projectSearches: 0 };
  let activeElement: Element | null = null;
  class Element {
    readonly children: Element[] = [];
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly handlers = new Map<string, Handler[]>();
    readonly classList = { toggle() {} };
    parentNode: Element | null = null;
    className = '';
    textContent = '';
    checked = false;
    indeterminate = false;
    disabled = false;
    hidden = false;
    open = false;
    tabIndex = -1;
    title = '';
    type = '';
    colSpan = 1;
    constructor(readonly tagName: string) { metrics.created++; }
    get firstChild(): Element | null { return this.children[0] ?? null; }
    get nextSibling(): Element | null {
      if (!this.parentNode) return null;
      return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
    }
    append(...elements: Element[]): void {
      for (const element of elements) {
        if (element.tagName === '#fragment') this.append(...[...element.children]);
        else this.insertBefore(element, null);
      }
    }
    insertBefore(element: Element, before: Element | null): void {
      element.parentNode?.removeChild(element);
      const index = before ? this.children.indexOf(before) : this.children.length;
      assert.ok(index >= 0);
      this.children.splice(index, 0, element); element.parentNode = this;
      if (this.tagName === 'tbody') metrics.inserted++;
    }
    removeChild(element: Element): void {
      const index = this.children.indexOf(element);
      assert.ok(index >= 0);
      this.children.splice(index, 1); element.parentNode = null;
      if (this.tagName === 'tbody') metrics.removed++;
    }
    replaceChildren(...elements: Element[]): void {
      for (const child of [...this.children]) this.removeChild(child);
      this.append(...elements);
    }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    addEventListener(name: string, handler: Handler): void {
      const handlers = this.handlers.get(name) ?? []; handlers.push(handler); this.handlers.set(name, handlers); metrics.listeners++;
    }
    fire(name: string, details: Record<string, unknown> = {}): void {
      const event = { target: this, currentTarget: this, preventDefault() {}, ...details };
      for (const handler of this.handlers.get(name) ?? []) handler(event);
    }
    focus(): void { activeElement = this; this.fire('focus'); }
    closest(selector: string): Element | null {
      if (selector === 'tr[data-key]' && this.tagName === 'tr' && this.dataset.key) return this;
      return this.parentNode?.closest(selector) ?? null;
    }
    contains(other: Element): boolean { return this === other || this.children.some(child => child.contains(other)); }
    querySelectorAll(selector: string): Element[] {
      const tags = selector.split(',').map(part => part.trim());
      const result: Element[] = [];
      const walk = (element: Element): void => {
        for (const child of element.children) {
          if (tags.includes(child.tagName)) result.push(child);
          walk(child);
        }
      };
      walk(this); return result;
    }
    querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const ids = new Map<string, Element>();
  for (const id of ['rows', 'status', 'preset', 'notice', 'sandbox-details', 'scope-notice', 'configuration-actions', 'recover-saved', 'reconfigure-access', 'open-workspace-folder', 'workspace', 'workspace-path', 'codex-workspace-path', 'chat-help', 'collapse-all', 'permissions']) {
    ids.set(id, new Element(id === 'rows' ? 'tbody' : id === 'collapse-all' ? 'button' : 'div'));
  }
  const commands = [
    ['open-workspace-folder', 'openWorkspaceFolder'], ['reconfigure-access', 'reconfigure'], ['recover-saved', 'recover'],
    ['workspace', 'selectWorkspace'], ['menu-reconfigure', 'reconfigure'], ['menu-recover', 'recover'],
  ].map(([id, command]) => {
    const button = ids.get(id) ?? new Element('button');
    button.dataset.command = command;
    ids.set(id, button);
    return button;
  });
  const body = ids.get('rows')!;
  const windowHandlers = new Map<string, Handler>();
  const posted: any[] = [];
  const document = {
    getElementById: (id: string) => ids.get(id),
    createElement: (tag: string) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
    querySelectorAll: (selector: string) => selector === '[data-command]' ? commands : [],
    addEventListener() {},
    hasFocus: () => activeElement !== null,
    get activeElement() { return activeElement; },
  };
  const filename = process.env.AGENTSCOPE_TEST_SCOPES_SCRIPT ?? path.resolve(__dirname, '../../media/scopes.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    document, Element,
    window: { addEventListener: (name: string, handler: Handler) => windowHandlers.set(name, handler) },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
  }, { filename });
  const send = (message: unknown): void => { windowHandlers.get('message')!({ data: message }); };
  const reset = (): void => { for (const key of Object.keys(metrics) as Array<keyof Metrics>) metrics[key] = 0; };
  const row = (name: string, relative = '.', target = 'project'): Element => {
    const key = JSON.stringify([target, name, relative]);
    const found = body.children.find(element => element.dataset.key === key);
    assert.ok(found, `Missing row ${key}`); return found;
  };
  const control = (element: Element, key: 'access' | 'action', value: string): Element => {
    const found = element.querySelectorAll('input, button').find(item => item.dataset[key] === value);
    assert.ok(found, `Missing ${key}: ${value}`); return found;
  };
  const expand = (name: string, relative = '.', target = 'project'): any => {
    control(row(name, relative, target), 'action', 'expand').fire('click');
    const request = posted.at(-1); assert.equal(request.type, 'children'); return request;
  };
  const children = (request: any, rows: unknown[], error?: string): void => { send({ ...request, rows, error }); };
  const state = (projects: any[], extra: Record<string, unknown> = {}): any => {
    Object.defineProperty(projects, 'find', { configurable: true, value: (...args: any[]) => {
      metrics.projectSearches++; return (Array.prototype.find as any).apply(projects, args);
    } });
    return { workspaceId: 1, workspace: 'MyApps', caseSensitive: true, trusted: true, busy: false, dirty: false, message: '', projects, ...extra };
  };
  return { send, reset, metrics, body, posted, row, control, expand, children, state, ids, document };
}

const selection = { checked: false, partial: false, inherited: false };
function projectRow(name: string, overrides: Record<string, unknown> = {}) {
  return { name, relative: '.', label: name, directory: true, project: true, enabled: false,
    read: selection, write: selection,
    scope: { path: name, enabled: false, restrict_paths: true, read_paths: [], write_paths: [], instruction_file: null }, ...overrides };
}
function fileRow(name: string, relative: string, directory = false) {
  return { name, relative, label: path.posix.basename(relative), directory, project: false, read: selection, write: selection };
}

test('The view shows full workspace paths without claiming the editor preset is selected in Codex', () => {
  const ui = browser();
  ui.send({ type: 'state', state: ui.state([], {
    workspacePath: 'D:\\Nexus\\MyApps', codexWorkspacePath: '/mnt/d/Nexus/MyApps', preset: 'VSPlayer',
  }) });
  assert.equal(ui.ids.get('workspace-path')!.textContent, 'Workspace: D:\\Nexus\\MyApps');
  assert.equal(ui.ids.get('codex-workspace-path')!.textContent, 'Configured Codex path: /mnt/d/Nexus/MyApps');
  assert.equal(ui.ids.get('workspace')!.title, 'D:\\Nexus\\MyApps');
  assert.match(ui.ids.get('chat-help')!.textContent, /select workspace “\/mnt\/d\/Nexus\/MyApps”, then select the chosen preset in Permissions/);
  assert.doesNotMatch(ui.ids.get('chat-help')!.textContent, /VSPlayer/);
  assert.equal(ui.ids.get('configuration-actions')!.hidden, true);
  ui.send({ type: 'state', state: ui.state([]) });
  assert.equal(ui.ids.get('workspace-path')!.hidden, true);
  assert.equal(ui.ids.get('codex-workspace-path')!.hidden, true);
  assert.equal(ui.ids.get('chat-help')!.textContent, 'Choose a preset, then select it in Codex Permissions.');
});

test('An unavailable workspace offers relocation instead of configuration repair', () => {
  const ui = browser();
  ui.send({ type: 'state', state: ui.state([projectRow('app')], {
    workspaceUnavailable: true, configurationError: 'Workspace folder no longer exists: D:\\MyApps', recoveryAvailable: true,
  }) });
  assert.equal(ui.ids.get('configuration-actions')!.hidden, false);
  assert.equal(ui.ids.get('open-workspace-folder')!.hidden, false);
  assert.equal(ui.ids.get('open-workspace-folder')!.disabled, false);
  for (const id of ['recover-saved', 'reconfigure-access', 'menu-recover', 'menu-reconfigure']) {
    assert.equal(ui.ids.get(id)!.hidden, true);
    assert.equal(ui.ids.get(id)!.disabled, true);
  }
  assert.match(ui.ids.get('notice')!.textContent, /Open its current location/);
  assert.doesNotMatch(ui.ids.get('notice')!.textContent, /Reconfigure|Recover saved configuration/);
  assert.match(ui.body.children[0].firstChild!.textContent, /Workspace folder is unavailable/);
  const before = ui.posted.length;
  ui.ids.get('open-workspace-folder')!.fire('click');
  assert.equal(ui.posted.length, before + 1);
  assert.equal(ui.posted.at(-1).command, 'openWorkspaceFolder');
  ui.send({ type: 'state', state: ui.state([], { configurationError: 'Invalid configuration', recoveryAvailable: true }) });
  assert.equal(ui.ids.get('open-workspace-folder')!.hidden, true);
  for (const id of ['recover-saved', 'reconfigure-access', 'menu-recover', 'menu-reconfigure']) assert.equal(ui.ids.get(id)!.hidden, false);
});

test('Opening a current folder is available without a trusted workspace and respects busy and pending guards', () => {
  const ui = browser();
  ui.send({ type: 'state', state: ui.state([], { workspace: null, trusted: false, configurationError: 'No local workspace' }) });
  const open = ui.ids.get('open-workspace-folder')!;
  assert.equal(open.hidden, false);
  assert.equal(open.disabled, false);
  open.fire('click');
  assert.equal(ui.posted.at(-1).command, 'openWorkspaceFolder');
  const beforeBusy = ui.posted.length;
  ui.send({ type: 'state', state: ui.state([], { busy: true, workspaceUnavailable: true }) });
  assert.equal(open.disabled, true);
  open.fire('click');
  assert.equal(ui.posted.length, beforeBusy);
  ui.send({ type: 'state', state: ui.state([projectRow('app')]) });
  ui.control(ui.row('app'), 'access', 'read').fire('change');
  const beforePending = ui.posted.length;
  assert.equal(open.disabled, true);
  open.fire('click');
  assert.equal(ui.posted.length, beforePending);
});

test('Sandbox information stays in collapsed details and disappears after a runtime change', () => {
  const ui = browser();
  const notice = ui.ids.get('notice')!;
  const details = ui.ids.get('sandbox-details')!;
  const scopeNotice = ui.ids.get('scope-notice')!;
  const state = ui.state([projectRow('app')], {
    scopeNotice: 'Windows compatibility: files outside selected paths, including disabled projects, remain readable.',
  });
  ui.send({ type: 'state', state });
  assert.equal(notice.hidden, true);
  assert.equal(details.hidden, false);
  assert.equal(details.open, false);
  assert.match(scopeNotice.textContent, /outside selected paths.*disabled projects.*readable/);
  details.open = true;
  ui.send({ type: 'state', state });
  assert.equal(details.open, true, 'Keep the user\'s expanded details open across refreshes');
  ui.send({ type: 'state', state: { ...state, scopeNotice: undefined } });
  assert.equal(details.hidden, true);
  assert.equal(details.open, false);
  assert.equal(scopeNotice.textContent, '');
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
});

test('Workspace warnings remain visible separately from the sandbox details', () => {
  const ui = browser();
  ui.send({ type: 'state', state: ui.state([], { trusted: false, scopeNotice: 'Native Windows sandbox information.' }) });
  assert.equal(ui.ids.get('notice')!.hidden, false);
  assert.match(ui.ids.get('notice')!.textContent, /Restricted Mode/);
  assert.doesNotMatch(ui.ids.get('notice')!.textContent, /Native Windows/);
  assert.equal(ui.ids.get('scope-notice')!.textContent, 'Native Windows sandbox information.');
});

test('An unchanged 200-project state creates no new rows, listeners or table mutations', t => {
  const ui = browser();
  const projects = Array.from({ length: 200 }, (_, index) => projectRow(`app-${index}`));
  ui.send({ type: 'state', state: ui.state(projects) });
  const firstRows = [...ui.body.children];
  ui.reset();
  ui.send({ type: 'state', state: ui.state(structuredClone(projects)) });
  t.diagnostic(`200 project rows, unchanged state: ${JSON.stringify(ui.metrics)}`);
  assert.equal(ui.metrics.created, 0);
  assert.equal(ui.metrics.listeners, 0);
  assert.equal(ui.metrics.inserted + ui.metrics.removed, 0);
  assert.equal(ui.metrics.projectSearches, 0, 'Project lookups must not linearly search the project array for every row');
  assert.deepEqual(ui.body.children, firstRows);
});

test('Children arrival keeps existing rows and collapse/re-expand reuses loaded child controls', t => {
  const ui = browser();
  ui.send({ type: 'state', state: ui.state(Array.from({ length: 200 }, (_, index) => projectRow(`app-${index}`))) });
  const roots = [...ui.body.children];
  const request = ui.expand('app-0');
  ui.reset();
  ui.children(request, Array.from({ length: 50 }, (_, index) => fileRow('app-0', `file-${index}.ts`)));
  t.diagnostic(`50 new children beside 200 existing roots: ${JSON.stringify(ui.metrics)}`);
  assert.equal(ui.metrics.inserted, 50);
  assert.equal(ui.metrics.removed, 1, 'Remove only the loading row');
  for (let index = 0; index < roots.length; index++) assert.equal(ui.row(`app-${index}`), roots[index]);
  const children = ui.body.children.filter(row => row.dataset.key && JSON.parse(row.dataset.key)[2] !== '.');
  ui.row('app-0', 'file-0.ts').focus();
  ui.ids.get('collapse-all')!.fire('click');
  assert.equal(ui.document.activeElement, ui.row('app-0'));
  assert.equal(ui.row('app-0').getAttribute('aria-expanded'), 'false');
  ui.reset();
  ui.control(ui.row('app-0'), 'action', 'expand').fire('click');
  assert.equal(ui.metrics.created, 0);
  assert.equal(ui.metrics.listeners, 0);
  for (const child of children) assert.ok(ui.body.children.includes(child));
  assert.equal(ui.row('app-0').getAttribute('aria-expanded'), 'true');
});

test('Reused rows update busy controls, permission badges and keyboard focus correctly', () => {
  const ui = browser();
  const project = projectRow('app', { enabled: true,
    scope: { path: 'app', enabled: true, restrict_paths: true, read_paths: ['src'], write_paths: [], instruction_file: 'app/src/guide.md' } });
  const state = ui.state([project]);
  ui.send({ type: 'state', state });
  ui.children(ui.expand('app'), [fileRow('app', 'src', true), fileRow('app', 'README.md')]);
  const src = ui.row('app', 'src');
  const readme = ui.row('app', 'README.md');
  assert.equal(ui.control(src, 'access', 'read').checked, true);
  assert.equal(ui.control(src, 'access', 'write').checked, false);
  src.focus(); src.fire('keydown', { key: 'ArrowDown' });
  assert.equal(ui.document.activeElement, readme);
  readme.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.document.activeElement, ui.row('app'));

  ui.reset();
  ui.send({ type: 'state', state: { ...state, busy: true } });
  assert.equal(ui.metrics.created, 0);
  assert.equal(ui.row('app', 'src'), src);
  assert.equal(ui.control(src, 'access', 'read').disabled, true);
  assert.equal(ui.control(ui.row('app'), 'action', 'expand').disabled, true);
  const next = structuredClone(state);
  next.projects[0].scope.write_paths = ['src'];
  ui.send({ type: 'state', state: next });
  assert.equal(ui.control(ui.row('app', 'src'), 'access', 'write').checked, true);
  assert.equal(ui.control(ui.row('app', 'src'), 'access', 'read').disabled, false);
  assert.equal(ui.row('app', 'README.md'), readme, 'An unrelated path keeps its existing controls');
  assert.equal(ui.control(ui.row('app'), 'access', 'write').indeterminate, true);
  assert.equal(next.projects[0].scope.instruction_file, 'app/src/guide.md');
});

test('Workspace resource parent selection remains separate from project selection during reuse', () => {
  const ui = browser();
  const resource = { ...fileRow('@workspace', '.', true), target: 'resource', label: 'Workspace files', selectable: true,
    read: { checked: true, partial: false, inherited: false },
    scope: { path: '.', enabled: true, restrict_paths: true, read_paths: ['README.md'], write_paths: [], instruction_file: null } };
  const state = ui.state([projectRow('app')], { resources: resource });
  ui.send({ type: 'state', state });
  ui.children(ui.expand('@workspace', '.', 'resource'), [{ ...fileRow('@workspace', 'README.md'), target: 'resource' }]);
  const file = ui.row('@workspace', 'README.md', 'resource');
  assert.equal(ui.control(file, 'access', 'read').checked, true);
  assert.equal(ui.control(ui.row('app'), 'access', 'read').checked, false);
  ui.send({ type: 'state', state: structuredClone(state) });
  assert.equal(ui.row('@workspace', 'README.md', 'resource'), file);
  assert.equal(ui.control(ui.row('@workspace', '.', 'resource'), 'access', 'read').checked, true);
});
