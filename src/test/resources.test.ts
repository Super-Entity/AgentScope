import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { emptyRegistry } from '../core/registry';
import { isResourcePath, listWorkspaceChildren, listWorkspaceSelectionRoots, resourceScope, selectedResourceState, selectedWorkspaceState, toggleResourceSelection, toggleWorkspaceSelection, workspaceSelectionState } from '../resources';
import { applyPlan } from '../transactions';
import { buildApplyPlan, loadWorkspace } from '../workspace';
import { directoryLink, fixture, policy, project } from './helpers';

function resources() {
  const value = emptyRegistry();
  value.submodules.library = project({ path: 'packages/library', enabled: false, read_paths: [], write_paths: [] });
  return value;
}

test('Workspace resources list one level without reading contents or traversing project roots', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await fs.mkdir(path.join(root, 'Instructions', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'README.md'), 'documentation');
  await fs.writeFile(path.join(root, 'Instructions', 'nested', 'guide.md'), 'instructions');
  const listed: string[] = [];
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listed.push(String(args[0]));
    return readdir(...args);
  });
  t.mock.method(fs, 'readFile', async () => { throw new Error('Browsing must not read file contents'); });
  const children = await listWorkspaceChildren(root, value);
  assert.deepEqual(children.map(child => child.relative), ['Instructions', 'packages', 'README.md']);
  assert.equal(children.find(child => child.relative === 'Instructions')?.selectable, true);
  assert.equal(children.find(child => child.relative === 'packages')?.selectable, false);
  assert.deepEqual(listed, [root]);
  assert.deepEqual(await listWorkspaceChildren(root, value, 'packages'), []);
  assert.deepEqual(listed, [root, path.join(root, 'packages')]);
  await assert.rejects(listWorkspaceChildren(root, value, 'packages/library'), /registered project/);
  assert.equal(listed.length, 2);
});

test('Checking one Instructions file grants just that file and preserves shared metadata and projects', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  value.shared_resources.description = 'Retain user metadata';
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await fs.writeFile(path.join(root, 'Instructions', 'Other.md'), 'other');
  const original = structuredClone(value);
  const read = await toggleResourceSelection(root, value, 'Instructions/Writer.md', 'read', true, false);
  assert.deepEqual(read.read_paths, ['Instructions/Writer.md']);
  assert.deepEqual(read.write_paths, []);
  assert.equal(read.description, 'Retain user metadata');
  const draft = { ...value, shared_resources: read };
  assert.equal(selectedResourceState(draft, 'Instructions', 'read').partial, true);
  assert.equal(selectedResourceState(draft, 'Instructions/Writer.md', 'read').checked, true);
  assert.equal(selectedResourceState(draft, 'Instructions/Other.md', 'read').checked, false);
  const write = await toggleResourceSelection(root, value, 'Instructions/Writer.md', 'write', true, false);
  assert.deepEqual(write.read_paths, []);
  assert.deepEqual(write.write_paths, ['Instructions/Writer.md']);
  assert.equal(selectedResourceState({ ...value, shared_resources: write }, 'Instructions/Writer.md', 'read').checked, true);
  assert.equal(selectedResourceState({ ...value, shared_resources: write }, 'Instructions/Other.md', 'write').checked, false);
  assert.deepEqual(value, original);
  assert.equal(value.submodules.library.enabled, false);
});

test('A root README can be selected independently without granting the workspace root', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.writeFile(path.join(root, 'README.md'), 'documentation');
  const draft = await toggleResourceSelection(root, value, 'README.md', 'write', true, false);
  assert.deepEqual(draft, { read_paths: [], write_paths: ['README.md'] });
  assert.equal(resourceScope({ ...value, shared_resources: draft }).enabled, true);
  assert.equal(resourceScope({ ...value, shared_resources: draft }).restrict_paths, true);
  assert.equal(isResourcePath(value, '.'), false);
  await assert.rejects(toggleResourceSelection(root, value, '.', 'write', true, true), /cannot be granted/);
});

test('Removing an inherited Instructions file retains siblings without listing nested sibling directories', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  value.shared_resources.read_paths = ['Instructions'];
  value.shared_resources.write_paths = ['Instructions'];
  await fs.mkdir(path.join(root, 'Instructions', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await fs.writeFile(path.join(root, 'Instructions', 'Other.md'), 'other');
  const original = structuredClone(value);
  const listed: string[] = [];
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listed.push(String(args[0]));
    return readdir(...args);
  });
  const updated = await toggleResourceSelection(root, value, 'Instructions/Writer.md', 'read', false, false);
  assert.deepEqual(new Set(updated.read_paths), new Set(['Instructions/nested', 'Instructions/Other.md']));
  assert.deepEqual(new Set(updated.write_paths), new Set(['Instructions/nested', 'Instructions/Other.md']));
  assert.deepEqual(listed, [path.join(root, 'Instructions')]);
  assert.deepEqual(value, original);
});

test('Removing write preserves explicit read access to the same resource folder', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  value.shared_resources.read_paths = ['Instructions'];
  value.shared_resources.write_paths = ['Instructions'];
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await fs.writeFile(path.join(root, 'Instructions', 'Other.md'), 'other');
  const updated = await toggleResourceSelection(root, value, 'Instructions/Writer.md', 'write', false, false);
  assert.deepEqual(updated.read_paths, ['Instructions']);
  assert.deepEqual(updated.write_paths, ['Instructions/Other.md']);
  const draft = { ...value, shared_resources: updated };
  assert.equal(selectedResourceState(draft, 'Instructions/Writer.md', 'read').checked, true);
  assert.equal(selectedResourceState(draft, 'Instructions/Writer.md', 'write').checked, false);
});

test('Project ancestors remain expandable but cannot grant shared access into a disabled project', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'guides'));
  await fs.writeFile(path.join(root, 'packages', 'guides', 'setup.md'), 'guide');
  assert.equal(isResourcePath(value, 'packages'), false);
  assert.equal(isResourcePath(value, 'packages/library'), false);
  assert.equal(isResourcePath(value, 'packages/library/private.md'), false);
  assert.equal(isResourcePath(value, 'packages/guides/setup.md'), true);
  await assert.rejects(toggleResourceSelection(root, value, 'packages', 'read', true, true), /cannot be granted/);
  await assert.rejects(toggleResourceSelection(root, value, 'packages/library/private.md', 'write', true, false), /cannot be granted/);
  const updated = await toggleResourceSelection(root, value, 'packages/guides/setup.md', 'read', true, false);
  assert.deepEqual(updated.read_paths, ['packages/guides/setup.md']);
  assert.equal(value.submodules.library.enabled, false);
});

test('Aliases into disabled projects are omitted and cannot be expanded or selected', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await directoryLink(path.join(root, 'packages', 'library'), path.join(root, 'Instructions'));
  const original = structuredClone(value);
  assert.equal((await listWorkspaceChildren(root, value)).some(child => child.relative === 'Instructions'), false);
  await assert.rejects(listWorkspaceChildren(root, value, 'Instructions'), /registered project/);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions', 'write', true, true), /overlaps.*registered project/);
  assert.deepEqual(value, original);
});

test('A registered project alias also blocks its canonical location and ancestors', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'Instructions', 'private'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages'));
  await fs.writeFile(path.join(root, 'Instructions', 'public.md'), 'guide');
  await directoryLink(path.join(root, 'Instructions', 'private'), path.join(root, 'packages', 'library'));
  const children = await listWorkspaceChildren(root, value);
  assert.equal(children.find(child => child.relative === 'Instructions')?.selectable, false);
  assert.deepEqual((await listWorkspaceChildren(root, value, 'Instructions')).map(child => child.relative), ['Instructions/public.md']);
  await assert.rejects(listWorkspaceChildren(root, value, 'Instructions/private'), /registered project/);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions', 'read', true, true), /overlaps.*registered project/);
  const selected = await toggleResourceSelection(root, value, 'Instructions/public.md', 'read', true, false);
  assert.deepEqual(selected.read_paths, ['Instructions/public.md']);
});

test('Escapes and metadata paths including aliases cannot be browsed or granted', async (t) => {
  const { root, outside } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await directoryLink(outside, path.join(root, 'escape'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'git-alias'));
  assert.equal(isResourcePath(value, '../outside'), false);
  assert.equal(isResourcePath(value, '.git/objects'), false);
  assert.equal(isResourcePath(value, 'Instructions/.git'), false);
  assert.equal((await listWorkspaceChildren(root, value)).some(child => ['escape', 'git-alias', '.git'].includes(child.relative)), false);
  await assert.rejects(listWorkspaceChildren(root, value, '../outside'), /parent|traverse/);
  await assert.rejects(listWorkspaceChildren(root, value, 'escape'), /symbolic link|junction/);
  await assert.rejects(listWorkspaceChildren(root, value, '.git'), /metadata/);
  await assert.rejects(listWorkspaceChildren(root, value, 'git-alias'), /metadata/);
  await assert.rejects(toggleResourceSelection(root, value, 'git-alias', 'read', true, true), /metadata/);
  await assert.rejects(toggleResourceSelection(root, value, 'escape', 'read', true, true), /symbolic link|junction/);
});

test('Strict listings refuse omitted boundaries, metadata and unsafe links', async (t) => {
  const { root, outside } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await assert.rejects(listWorkspaceChildren(root, value, 'packages', { strict: true }), /Registered project/);
  await assert.rejects(listWorkspaceChildren(root, value, '.', { strict: true }), /project boundary/);
  await fs.mkdir(path.join(root, 'Instructions', '.git'), { recursive: true });
  await assert.rejects(listWorkspaceChildren(root, value, 'Instructions', { strict: true }), /metadata/);
  await fs.mkdir(path.join(root, 'shared'));
  await directoryLink(outside, path.join(root, 'shared', 'escape'));
  await assert.rejects(listWorkspaceChildren(root, value, 'shared', { strict: true }), /symbolic link|junction/);
});

test('Inherited shared-resource narrowing refuses safe sibling aliases instead of regranting excluded content', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  value.shared_resources.write_paths = ['Instructions'];
  await fs.mkdir(path.join(root, 'Instructions', 'actual'), { recursive: true });
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await directoryLink(path.join(root, 'Instructions', 'actual'), path.join(root, 'Instructions', 'alias'));
  const original = structuredClone(value);
  const children = await listWorkspaceChildren(root, value, 'Instructions');
  assert.equal(children.find(child => child.relative === 'Instructions/alias')?.symbolicLink, true);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions/Writer.md', 'write', false, false), /symbolic link|junction/);
  assert.deepEqual(value, original);
});

test('A missing or changed displayed resource cannot gain broader access', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  const original = structuredClone(value);
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.mkdir(path.join(root, 'Instructions', 'was-file.md'));
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions/was-file.md', 'write', true, false), /changed.*Refresh/);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions/missing.md', 'write', true, false), /changed.*Refresh/);
  assert.deepEqual(value, original);
});

test('A workspace represented by a root project has no overlapping shared-resource access', async (t) => {
  const { root } = await fixture(t);
  const value = emptyRegistry();
  value.submodules.root = project({ path: '.', enabled: false, read_paths: [], write_paths: [] });
  await fs.mkdir(path.join(root, 'Instructions'));
  assert.equal(isResourcePath(value, 'Instructions'), false);
  await assert.rejects(listWorkspaceChildren(root, value), /registered project/);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions', 'write', true, true), /cannot be granted/);
});

test('Shared resource drafts preserve instruction validation and fail without changing their input', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  value.submodules.library.enabled = true;
  value.submodules.library.instruction_file = 'Instructions/Writer.md';
  value.shared_resources.read_paths = ['Instructions/Writer.md'];
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  const original = structuredClone(value);
  await assert.rejects(toggleResourceSelection(root, value, 'Instructions/Writer.md', 'read', false, false), /instruction_file.*outside/);
  assert.deepEqual(value, original);
});

test('Applying and reloading one writable resource creates an exact profile grant and retains disabled project deny', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await fs.writeFile(path.join(root, 'Instructions', 'Other.md'), 'other');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  const state = await loadWorkspace(root);
  state.registry.shared_resources = await toggleResourceSelection(root, state.registry, 'Instructions/Writer.md', 'write', true, false);
  const options = { generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false };
  const plan = await buildApplyPlan(state, options);
  const config = plan.changes.find(change => change.path.endsWith('config.toml'))!.after;
  const permissions = (TOML.parse(config) as unknown as { permissions: { agentscope: { filesystem: Record<string, string> } } }).permissions.agentscope.filesystem;
  assert.equal(permissions[path.join(root, 'Instructions', 'Writer.md')], 'write');
  assert.equal(permissions[path.join(root, 'Instructions')], undefined);
  assert.equal(permissions[path.join(root, 'Instructions', 'Other.md')], undefined);
  assert.equal(permissions[path.join(root, 'packages', 'library')], 'deny');
  assert.equal(permissions[':root'], 'deny');
  await applyPlan(plan);
  const reloaded = await loadWorkspace(root);
  assert.deepEqual(reloaded.registry.shared_resources, { read_paths: [], write_paths: ['Instructions/Writer.md'] });
  assert.equal(reloaded.registry.submodules.library.enabled, false);
  assert.equal((await buildApplyPlan(reloaded, options)).changes.length, 0);
});

test('Aggregate resource selection expands only project ancestors and skips project, metadata and escaping aliases', async (t) => {
  const { root, outside } = await fixture(t);
  const value = resources();
  value.submodules.tool = project({ path: 'packages/vendor/tool', enabled: false, read_paths: [], write_paths: [] });
  value.shared_resources.description = 'Retain resource metadata';
  await fs.mkdir(path.join(root, 'packages', 'library'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'vendor', 'tool'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'guides', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'Instructions', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'README.md'), 'overview');
  await fs.writeFile(path.join(root, 'packages', 'vendor', 'notes.md'), 'notes');
  await directoryLink(path.join(root, 'packages', 'library'), path.join(root, 'project-alias'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'metadata-alias'));
  await directoryLink(outside, path.join(root, 'escape'));
  await directoryLink(root, path.join(root, 'root-alias'));
  const listed: string[] = [];
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listed.push(String(args[0]));
    return readdir(...args);
  });
  t.mock.method(fs, 'readFile', async () => { throw new Error('Aggregate selection must not read contents'); });
  const frontier = await listWorkspaceSelectionRoots(root, value);
  assert.deepEqual(new Set(frontier.map(entry => entry.relative)), new Set(['Instructions', 'README.md', 'packages/guides', 'packages/vendor/notes.md']));
  assert.deepEqual(new Set(listed), new Set([root, path.join(root, 'packages'), path.join(root, 'packages', 'vendor')]));
  assert.equal(listed.length, 3, 'No ordinary folder or project content may be recursively discovered');
  const original = structuredClone(value);
  const selected = await toggleWorkspaceSelection(root, value, 'write', true);
  assert.deepEqual(selected.write_paths, frontier.map(entry => entry.relative));
  assert.deepEqual(selected.read_paths, []);
  assert.equal(selected.description, 'Retain resource metadata');
  assert.deepEqual(value, original);
  const draft = { ...value, shared_resources: selected };
  assert.deepEqual(workspaceSelectionState(draft, frontier, 'read'), { checked: true, partial: false, inherited: false });
  assert.deepEqual(workspaceSelectionState(draft, frontier, 'write'), { checked: true, partial: false, inherited: false });
  assert.equal(selected.write_paths.includes('.'), false);
  assert.equal(draft.submodules.library.enabled, false);
  assert.equal(draft.submodules.tool.enabled, false);
});

test('Aggregate Read/Write choices preserve implications, clear semantics and selected instruction validation', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'guide');
  await fs.writeFile(path.join(root, 'README.md'), 'overview');
  value.shared_resources.read_paths = ['Instructions/Writer.md'];
  assert.deepEqual(await selectedWorkspaceState(root, value, 'read'), { checked: false, partial: true, inherited: false });
  const read = await toggleWorkspaceSelection(root, value, 'read', true);
  assert.deepEqual(read.read_paths, ['Instructions', 'README.md']);
  assert.deepEqual(read.write_paths, []);
  const readDraft = { ...value, shared_resources: read };
  const write = await toggleWorkspaceSelection(root, readDraft, 'write', true);
  const writable = { ...value, shared_resources: write };
  const writeCleared = await toggleWorkspaceSelection(root, writable, 'write', false);
  assert.deepEqual(writeCleared, { read_paths: ['Instructions', 'README.md'], write_paths: [] });
  assert.deepEqual(await toggleWorkspaceSelection(root, writable, 'read', false), { read_paths: [], write_paths: [] });
  writable.submodules.library.enabled = true;
  writable.submodules.library.instruction_file = 'Instructions/Writer.md';
  const original = structuredClone(writable);
  await assert.rejects(toggleWorkspaceSelection(root, writable, 'read', false), /instruction_file.*outside/);
  assert.deepEqual(writable, original);
});

test('Aggregate selection handles ordinary root projects and empty resource frontiers without granting the workspace root', async (t) => {
  const { root } = await fixture(t);
  const ordinary = emptyRegistry();
  ordinary.submodules.workspace = project({ path: '.', enabled: false, read_paths: [], write_paths: [] });
  await fs.mkdir(path.join(root, 'docs'));
  assert.deepEqual(await listWorkspaceSelectionRoots(root, ordinary), []);
  assert.deepEqual(await selectedWorkspaceState(root, ordinary, 'read'), { checked: false, partial: false, inherited: false });
  assert.deepEqual(await toggleWorkspaceSelection(root, ordinary, 'write', true), { read_paths: [], write_paths: [] });
  assert.equal(ordinary.submodules.workspace.enabled, false);
  const empty = emptyRegistry();
  await fs.rmdir(path.join(root, 'docs'));
  assert.deepEqual(await listWorkspaceSelectionRoots(root, empty), []);
  assert.deepEqual(await selectedWorkspaceState(root, empty, 'write'), { checked: false, partial: false, inherited: false });
  assert.deepEqual(await toggleWorkspaceSelection(root, empty, 'read', true), { read_paths: [], write_paths: [] });
});

test('Aggregate resource selection rejects unexpected listing failures and retargeted existing grants', async (t) => {
  const { root } = await fixture(t);
  const value = resources();
  await fs.mkdir(path.join(root, 'Instructions'));
  value.shared_resources.write_paths = ['Instructions'];
  await fs.mkdir(path.join(root, '.git'));
  await fs.rename(path.join(root, 'Instructions'), path.join(root, 'old-instructions'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'Instructions'));
  await assert.rejects(toggleWorkspaceSelection(root, value, 'read', true), /Git metadata/i);
  const fresh = resources();
  t.mock.method(fs, 'readdir', async () => { throw Object.assign(new Error('Denied listing'), { code: 'EACCES' }); });
  await assert.rejects(toggleWorkspaceSelection(root, fresh, 'write', true), /Denied listing/);
  assert.deepEqual(fresh.shared_resources, { read_paths: [], write_paths: [] });
});
