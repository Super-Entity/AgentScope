import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { parse } from 'jsonc-parser';
import { buildApplyPlan, loadWorkspace, ApplyOptions } from '../workspace';
import { ACCESS_POLICY_FILE, emptyRegistry, readAccessRegistry, writeAccessFiles } from '../core/registry';
import { applyPlan, restoreChanges } from '../transactions';
import { directoryLink, fixture, policy, project, registry } from './helpers';
import { toggleResourceSelection } from '../resources';

const options: ApplyOptions = { generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false };

function filesystem(text: string): Record<string, string> {
  return (TOML.parse(text) as unknown as { permissions: { agentscope: { filesystem: Record<string, string> } } }).permissions.agentscope.filesystem;
}

test('Workspace-resource visibility preserves unrelated exact exclusions and applies only explicit choices', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.mkdir(path.join(root, 'cache'));
  await fs.writeFile(path.join(root, 'README.md'), 'Overview\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{\n // Keep independent cache search visibility\n "files.exclude": { "cache": true, "**/build": true },\n "search.exclude": { "cache": false }, "editor.tabSize": 3\n}\n');
  const loaded = await loadWorkspace(root);
  assert.equal(loaded.resourceHidden?.cache, true);
  loaded.resourceHidden!.Instructions = true;
  loaded.resourceHidden!['README.md'] = true;
  loaded.resourceVisibilityChanges = { Instructions: true, 'README.md': true };
  await applyPlan(await buildApplyPlan(loaded, options));
  const text = await fs.readFile(path.join(root, '.vscode', 'settings.json'), 'utf8');
  const settings = parse(text);
  assert.match(text, /Keep independent cache search visibility/);
  assert.equal(settings['files.exclude'].cache, true);
  assert.equal(settings['search.exclude'].cache, false, 'Untouched root exclusions must not be synchronized into search');
  assert.equal(settings['files.exclude']['**/build'], true);
  assert.equal(settings['editor.tabSize'], 3);
  assert.equal(settings['files.exclude'].Instructions, true);
  assert.equal(settings['search.exclude']['README.md'], true);
  const reloaded = await loadWorkspace(root);
  assert.equal(reloaded.resourceHidden?.Instructions, true);
  assert.equal(reloaded.resourceHidden?.['README.md'], true);
  assert.deepEqual((await buildApplyPlan(reloaded, options)).changes, []);
});

test('Workspace-resource visibility cannot hide a registered project through a linked alias', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  await directoryLink(path.join(root, 'project'), path.join(root, 'alias'));
  const loaded = await loadWorkspace(root);
  loaded.resourceVisibilityChanges = { alias: true };
  await assert.rejects(buildApplyPlan(loaded, options), /resource visibility.*registered project/i);
  await assert.rejects(fs.stat(path.join(root, '.vscode')), { code: 'ENOENT' });
});

test('Loading discovers submodules disabled and reads visibility without writing configuration', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "docs-service"]\n path = packages/docs\n');
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ // retained\n "files.exclude": { "packages/docs": true }\n}\n');
  const state = await loadWorkspace(root);
  assert.deepEqual(state.registry.submodules['docs-service'], project({ path: 'packages/docs', enabled: false, read_paths: [], write_paths: [] }));
  assert.equal(state.hidden['docs-service'], true);
  assert.equal(state.dirty, false);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('Ordinary workspaces start with a disabled root project but explicit empty policies stay empty', async (t) => {
  const { root } = await fixture(t);
  const state = await loadWorkspace(root);
  const entries = Object.values(state.registry.submodules);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], project({ path: '.', enabled: false, read_paths: [], write_paths: [] }));
  assert.equal(state.files?.[path.join(root, 'AGENTS.md')], null);
  assert.equal(state.files?.[path.join(root, ACCESS_POLICY_FILE)], null);
  assert.deepEqual(state.warnings, []);
  assert.equal((await fs.readdir(root)).length, 0);
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(emptyRegistry()));
  assert.deepEqual((await loadWorkspace(root)).registry.submodules, {});
});

test('A deleted AGENTS.md keeps saved access choices and only Apply recreates its reference', async (t) => {
  const { root } = await fixture(t);
  const saved = registry({
    project: project({ instruction_file: 'Instructions/Writer.md' }),
    disabled: project({ path: 'other', enabled: false, read_paths: ['notes'], write_paths: [], instruction_file: null }),
  });
  const generated = writeAccessFiles('', null, saved);
  const main = path.join(root, 'AGENTS.md');
  const access = path.join(root, ACCESS_POLICY_FILE);
  const settings = path.join(root, '.vscode', 'settings.json');
  const configuredSettings = '{\n "files.exclude": { "project": false, "other": false },\n "search.exclude": { "project": false, "other": false },\n "editor.tabSize": 3\n}\n';
  await fs.mkdir(path.dirname(access));
  await fs.mkdir(path.dirname(settings));
  await fs.mkdir(path.join(root, 'Instructions'));
  await fs.writeFile(path.join(root, 'Instructions', 'Writer.md'), 'Use this selected workflow.\n');
  await fs.writeFile(access, generated.access);
  await fs.writeFile(settings, configuredSettings);

  const state = await loadWorkspace(root);
  assert.deepEqual(state.registry, saved, 'Missing main instructions must not disable or broaden saved selections');
  assert.equal(state.files?.[main], null);
  assert.equal(state.files?.[access], generated.access);
  assert.deepEqual(state.warnings, ['AGENTS.md is missing. Apply will recreate its access reference; saved access settings are preserved.']);
  await assert.rejects(fs.stat(main), { code: 'ENOENT' }, 'Loading must not recreate the deleted file');

  const plan = await buildApplyPlan(state, { ...options, generateCodexProfile: false });
  assert.deepEqual(plan.changes, [{ path: main, before: null, after: generated.agents }]);
  assert.ok(plan.checks?.some(check => check.path === access && check.expected === generated.access));
  await assert.rejects(fs.stat(main), { code: 'ENOENT' }, 'Preview must not recreate the deleted file');
  await applyPlan(plan);
  assert.equal(await fs.readFile(main, 'utf8'), generated.agents);
  assert.equal(await fs.readFile(access, 'utf8'), generated.access);
  assert.equal(await fs.readFile(settings, 'utf8'), configuredSettings);
  assert.deepEqual((await loadWorkspace(root)).registry, saved);
  assert.deepEqual((await loadWorkspace(root)).warnings, []);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });

  await restoreChanges(plan.changes);
  await assert.rejects(fs.stat(main), { code: 'ENOENT' });
  assert.equal(await fs.readFile(access, 'utf8'), generated.access, 'Restore must preserve the pre-existing policy');
  assert.equal(await fs.readFile(settings, 'utf8'), configuredSettings);
  assert.deepEqual((await loadWorkspace(root)).registry, saved);
});

test('A deleted AGENTS.md cannot hide an invalid or user-owned access policy behind default discovery', async (t) => {
  for (const invalid of [
    'Unrelated user-owned notes.\n',
    writeAccessFiles('', null, registry()).access.replace('"enabled": true', '"enabled": invalid'),
  ]) {
    const { root } = await fixture(t);
    const access = path.join(root, ACCESS_POLICY_FILE);
    await fs.mkdir(path.dirname(access));
    await fs.writeFile(access, invalid);
    await assert.rejects(loadWorkspace(root), /managed policy|invalid|malformed|JSON/i);
    assert.equal(await fs.readFile(access, 'utf8'), invalid);
    await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, '.vscode')), { code: 'ENOENT' });
  }
});

test('New submodule discovery preserves an existing ordinary root registry instead of creating overlaps', async (t) => {
  const { root } = await fixture(t);
  const value = emptyRegistry();
  value.submodules.repository = project({ path: '.', enabled: false, read_paths: [], write_paths: [] });
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "library"]\n path = packages/library\n');
  const state = await loadWorkspace(root);
  assert.deepEqual(Object.keys(state.registry.submodules), ['repository']);
  assert.equal(state.registry.submodules.repository.path, '.');
  assert.ok(state.warnings.some(warning => /overlap/i.test(warning)));
});

test('Planning retains policies and JSONC settings; applying and reloading is idempotent', async (t) => {
  const { root } = await fixture(t);
  const initial = policy(registry());
  await fs.writeFile(path.join(root, 'AGENTS.md'), initial);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ // custom settings\n "editor.tabSize": 3\n}\n');
  const state = await loadWorkspace(root);
  state.hidden.project = true;
  const plan = await buildApplyPlan(state, options);
  assert.equal(plan.changes.length, 4);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), initial);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
  const settings = plan.changes.find(change => change.path.endsWith('settings.json'))!;
  assert.match(settings.after, /custom settings/);
  assert.equal(parse(settings.after)['editor.tabSize'], 3);
  await applyPlan(plan);
  const reloaded = await loadWorkspace(root);
  assert.equal(reloaded.hidden.project, true);
  assert.equal((await buildApplyPlan(reloaded, options)).changes.length, 0);
});

test('Disabling profile generation leaves conflicting Codex configuration untouched', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  await fs.mkdir(path.join(root, '.codex'));
  const config = 'sandbox_mode = "workspace-write"\nmodel = "existing"\n';
  await fs.writeFile(path.join(root, '.codex', 'config.toml'), config);
  const state = await loadWorkspace(root);
  const plan = await buildApplyPlan(state, { ...options, generateCodexProfile: false });
  assert.equal(plan.changes.some(change => change.path.endsWith('config.toml')), false);
  await assert.rejects(buildApplyPlan(state, options), /legacy sandbox settings/);
  assert.equal(await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8'), config);
});

test('External policy edits after loading are refused on Apply, preserving the edit', async (t) => {
  const { root } = await fixture(t);
  const original = policy(registry());
  const agents = path.join(root, 'AGENTS.md');
  await fs.writeFile(agents, original);
  const state = await loadWorkspace(root);
  state.registry.submodules.project.enabled = false;
  await fs.writeFile(agents, original + '\nUser added a rule.\n');
  const plan = await buildApplyPlan(state, options);
  await assert.rejects(applyPlan(plan), /changed.*refresh/i);
  assert.equal(await fs.readFile(agents, 'utf8'), original + '\nUser added a rule.\n');
  await assert.rejects(fs.stat(path.join(root, '.vscode')), { code: 'ENOENT' });
});

test('Scope links and shared-resource aliases cannot enter disabled projects', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.mkdir(path.join(root, 'secret'));
  await directoryLink(path.join(root, 'secret'), path.join(root, 'project', 'references'));
  const value = registry({ disabled: project({ path: 'secret', enabled: false }) });
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  const state = await loadWorkspace(root);
  await assert.rejects(buildApplyPlan(state, options), /symbolic link|junction|crosses/);
  await fs.unlink(path.join(root, 'project', 'references'));
  await directoryLink(path.join(root, 'secret'), path.join(root, 'Instructions'));
  await assert.rejects(buildApplyPlan(state, options), /shared resource.*registered project/);
});

test('A shared folder retargeted to parent Git metadata before planning cannot gain Write access', async (t) => {
  const { root } = await fixture(t);
  const value = registry();
  value.shared_resources.read_paths = [];
  await fs.mkdir(path.join(root, 'project'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'notes'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  const state = await loadWorkspace(root);
  state.registry.shared_resources = await toggleResourceSelection(root, state.registry, 'notes', 'write', true, true);
  await fs.rename(path.join(root, 'notes'), path.join(root, 'old-notes'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'notes'));
  await assert.rejects(buildApplyPlan(state, options), /Git metadata/i);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.agentscope')), { code: 'ENOENT' });
});

test('Project scopes and project-root aliases resolving into Git metadata are refused', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project', '.git'), { recursive: true });
  await directoryLink(path.join(root, 'project', '.git'), path.join(root, 'project', 'references'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  await assert.rejects(buildApplyPlan(await loadWorkspace(root), options), /Git metadata/i);
  const value = registry();
  value.submodules.project.path = 'linked-project';
  await fs.mkdir(path.join(root, '.git'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'linked-project'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  await assert.rejects(buildApplyPlan(await loadWorkspace(root), options), /Git metadata/i);
});

test('Selected instructions must exist and stay inside the verified readable scope', async (t) => {
  const { root, outside } = await fixture(t);
  const value = registry({ project: project({ instruction_file: 'Instructions/Writer.md' }) });
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
  const state = await loadWorkspace(root);
  await assert.rejects(buildApplyPlan(state, options), /instruction_file does not exist/);
  await directoryLink(outside, path.join(root, 'Instructions'));
  await assert.rejects(buildApplyPlan(state, options), /symbolic link|junction/);
});

test('A linked editor-settings directory is rejected before any configuration write', async (t) => {
  const { root, outside } = await fixture(t);
  const state = await loadWorkspace(root);
  await directoryLink(outside, path.join(root, '.vscode'));
  await assert.rejects(buildApplyPlan(state, options), /symbolic link|junction/);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Verified submodule pointers grant only their own Git metadata under the registered name', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  const metadata = path.join(root, '.git', 'modules', 'git-name');
  await fs.mkdir(moduleRoot);
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "git-name"]\n path = project\n');
  await fs.writeFile(path.join(moduleRoot, '.git'), 'gitdir: ../.git/modules/git-name\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  const plan = await buildApplyPlan(await loadWorkspace(root), options);
  const grants = filesystem(plan.changes.find(change => change.path.endsWith('config.toml'))!.after);
  assert.equal(grants[path.join(moduleRoot, '.git')], 'read');
  assert.equal(grants[metadata], 'write');
  assert.equal(grants[path.join(root, '.git')], undefined);
  assert.equal(grants[path.join(root, '.git', 'modules')], undefined);
});

test('Read-only projects receive read-only Git metadata; unsafe Git pointers add no grant', async (t) => {
  const { root, outside } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  const metadata = path.join(moduleRoot, '.git');
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry({ project: project({ write_paths: [] }) })));
  const readOnly = await buildApplyPlan(await loadWorkspace(root), options);
  assert.equal(filesystem(readOnly.changes.find(change => change.path.endsWith('config.toml'))!.after)[metadata], 'read');
  await fs.rmdir(metadata);
  await fs.writeFile(metadata, `gitdir: ${outside}\n`);
  const unsafe = await buildApplyPlan(await loadWorkspace(root), options);
  assert.equal(filesystem(unsafe.changes.find(change => change.path.endsWith('config.toml'))!.after)[outside], undefined);
  assert.equal(filesystem(unsafe.changes.find(change => change.path.endsWith('config.toml'))!.after)[metadata], undefined);
  assert.ok(unsafe.warnings.some(warning => /Git metadata was skipped/.test(warning)));
});

test('An internal Git pointer cannot broaden a leaf selection to ordinary project content', async (t) => {
  for (const [target, permission] of [['.', 'write'], ['private', 'read']] as const) {
    const { root } = await fixture(t);
    const moduleRoot = path.join(root, 'project');
    await fs.mkdir(path.join(moduleRoot, 'private'), { recursive: true });
    await fs.writeFile(path.join(moduleRoot, 'public.md'), 'Selected content.');
    await fs.writeFile(path.join(moduleRoot, 'private', 'secret.md'), 'Unselected content.');
    await fs.writeFile(path.join(moduleRoot, '.git'), `gitdir: ${target}\n`);
    const value = registry({ project: project({ read_paths: permission === 'read' ? ['public.md'] : [], write_paths: permission === 'write' ? ['public.md'] : [] }) });
    await fs.writeFile(path.join(root, 'AGENTS.md'), policy(value));
    const plan = await buildApplyPlan(await loadWorkspace(root), options);
    const grants = filesystem(plan.changes.find(change => change.path.endsWith('config.toml'))!.after);
    assert.equal(grants[path.join(moduleRoot, 'public.md')], permission);
    assert.equal(grants[moduleRoot], undefined);
    assert.equal(grants[path.join(moduleRoot, 'private')], undefined);
    assert.equal(grants[path.join(moduleRoot, '.git')], undefined);
    assert.ok(plan.warnings.some(warning => /project content instead of a dedicated \.git directory/.test(warning)));
  }
});

test('A legitimate internal pointer grants only the dedicated canonical Git subtree', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  const metadataRoot = path.join(moduleRoot, 'repository', '.git');
  const metadata = path.join(metadataRoot, 'worktrees', 'branch');
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(moduleRoot, 'public.md'), 'Selected content.');
  await fs.writeFile(path.join(moduleRoot, '.git'), 'gitdir: repository/.git/worktrees/branch\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry({ project: project({ read_paths: [], write_paths: ['public.md'] }) })));
  const plan = await buildApplyPlan(await loadWorkspace(root), options);
  const grants = filesystem(plan.changes.find(change => change.path.endsWith('config.toml'))!.after);
  assert.equal(grants[metadata], 'write');
  assert.equal(grants[path.join(moduleRoot, '.git')], 'read');
  assert.equal(grants[moduleRoot], undefined);
  assert.equal(grants[path.dirname(metadataRoot)], undefined);
  assert.equal(grants[metadataRoot], undefined);
  assert.ok(plan.pathChecks?.some(check => check.path === metadataRoot && check.resolved === metadataRoot));
});

test('A dedicated Git directory redirected to ordinary content receives no metadata grant', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  const privateDirectory = path.join(moduleRoot, 'private');
  await fs.mkdir(privateDirectory, { recursive: true });
  await fs.mkdir(path.join(moduleRoot, 'repository'));
  await directoryLink(privateDirectory, path.join(moduleRoot, 'repository', '.git'));
  await fs.writeFile(path.join(moduleRoot, '.git'), 'gitdir: repository/.git\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry({ project: project({ read_paths: ['public.md'], write_paths: [] }) })));
  const plan = await buildApplyPlan(await loadWorkspace(root), options);
  const grants = filesystem(plan.changes.find(change => change.path.endsWith('config.toml'))!.after);
  assert.equal(grants[privateDirectory], undefined);
  assert.equal(grants[path.join(moduleRoot, '.git')], undefined);
  assert.ok(plan.warnings.some(warning => /internal metadata root is redirected through a link/.test(warning)));
});

test('Loaded directory identity rejects replacement before planning and before applying', async (t) => {
  for (const replaceAfterPlan of [false, true]) {
    const { root } = await fixture(t);
    const state = await loadWorkspace(root);
    assert.ok(state.rootIdentity);
    const plan = replaceAfterPlan ? await buildApplyPlan(state, options) : undefined;
    if (plan) assert.deepEqual(plan.directoryChecks, [{ path: root, identity: state.rootIdentity }]);
    await fs.rename(root, root + '-original');
    await fs.mkdir(root);
    await assert.rejects(plan ? applyPlan(plan) : buildApplyPlan(state, options), /root directory changed.*refresh/i);
    assert.deepEqual(await fs.readdir(root), []);
    assert.deepEqual(await fs.readdir(root + '-original'), []);
  }
});

test('Adding ordinary children after loading keeps the draft valid', async (t) => {
  const { root } = await fixture(t);
  const state = await loadWorkspace(root);
  await fs.writeFile(path.join(root, 'notes.md'), 'Ordinary child edits do not replace the workspace.');
  await fs.mkdir(path.join(root, 'notes'));
  await applyPlan(await buildApplyPlan(state, { ...options, generateCodexProfile: false }));
  assert.equal(await fs.readFile(path.join(root, 'notes.md'), 'utf8'), 'Ordinary child edits do not replace the workspace.');
  assert.ok((await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).includes('AgentScope access reference'));
});

test('A root replacement during configuration loading cannot produce a healthy stale state', async (t) => {
  const { root } = await fixture(t);
  const main = path.join(root, 'AGENTS.md');
  const original = 'Original instructions.\n';
  await fs.writeFile(main, original);
  const realRead = fs.readFile.bind(fs);
  let swapped = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const contents = await realRead(...args);
    if (String(args[0]) === main && !swapped) {
      swapped = true;
      await fs.rename(root, root + '-original');
      await fs.mkdir(root);
      await fs.writeFile(main, original);
    }
    return contents;
  });
  await assert.rejects(loadWorkspace(root), /root directory changed.*refresh/i);
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(main, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['AGENTS.md']);
});

test('A submodule manifest edit after planning prevents all configuration writes', async (t) => {
  const { root } = await fixture(t);
  const manifest = path.join(root, '.gitmodules');
  await fs.writeFile(manifest, '[submodule "project"]\n path = project\n');
  const state = await loadWorkspace(root);
  const plan = await buildApplyPlan(state, options);
  await fs.writeFile(manifest, '[submodule "elsewhere"]\n path = elsewhere\n');
  await assert.rejects(applyPlan(plan), /input changed.*refresh/i);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.vscode')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('Retargeting a configured scope through a link after planning is refused', async (t) => {
  const { root } = await fixture(t);
  const references = path.join(root, 'project', 'references');
  const alternate = path.join(root, 'project', 'alternate');
  await fs.mkdir(references, { recursive: true });
  await fs.mkdir(alternate);
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  const state = await loadWorkspace(root);
  const plan = await buildApplyPlan(state, options);
  await fs.rename(references, path.join(root, 'project', 'old-references'));
  await directoryLink(alternate, references);
  await assert.rejects(applyPlan(plan), /scope changed.*link.*refresh/i);
  await assert.rejects(fs.stat(path.join(root, '.vscode')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('A changed Git pointer after planning cannot grant stale metadata permissions', async (t) => {
  const { root, outside } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  const metadata = path.join(root, '.git', 'modules', 'project');
  await fs.mkdir(moduleRoot);
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "project"]\n path = project\n');
  const pointer = path.join(moduleRoot, '.git');
  await fs.writeFile(pointer, 'gitdir: ../.git/modules/project\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
  const state = await loadWorkspace(root);
  const plan = await buildApplyPlan(state, options);
  await fs.writeFile(pointer, `gitdir: ${outside}\n`);
  await assert.rejects(applyPlan(plan), /input changed.*refresh/i);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('Split policy preserves existing user instructions and restores the original files', async (t) => {
  const { root } = await fixture(t);
  const main = '\uFEFF# Workspace rules\r\n\r\nKeep these instructions exactly.\r\n```json\r\n{"editor": "local"}\r\n```';
  await fs.writeFile(path.join(root, 'AGENTS.md'), main);
  const state = await loadWorkspace(root);
  state.registry = emptyRegistry();
  const plan = await buildApplyPlan(state, { ...options, generateCodexProfile: false });
  assert.deepEqual(plan.changes.map(change => path.relative(root, change.path).replace(/\\/g, '/')), [ACCESS_POLICY_FILE, 'AGENTS.md']);
  await assert.rejects(fs.stat(path.join(root, '.agentscope')), { code: 'ENOENT' }, 'Preview must not create files');
  await applyPlan(plan);
  const mainAfter = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const accessAfter = await fs.readFile(path.join(root, ACCESS_POLICY_FILE), 'utf8');
  assert.ok(mainAfter.startsWith('\uFEFF<!-- BEGIN AgentScope access reference -->'));
  assert.ok(mainAfter.endsWith(main.slice(1)), 'Original prose, fence and final newline must be preserved');
  assert.equal((mainAfter.match(/BEGIN AgentScope access reference/g) ?? []).length, 1);
  assert.deepEqual(readAccessRegistry(mainAfter, accessAfter), emptyRegistry());
  assert.deepEqual((await buildApplyPlan(await loadWorkspace(root), { ...options, generateCodexProfile: false })).changes, []);
  await restoreChanges(plan.changes);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), main);
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('Legacy migration retains JSONC annotations and subsequent access edits change only the sidecar', async (t) => {
  const { root } = await fixture(t);
  const value = registry();
  value.metadata = { owner: 'local' };
  const legacy = policy(value).replace('```json\n{', '```jsonc\n{\n  // Keep my access annotation');
  await fs.writeFile(path.join(root, 'AGENTS.md'), legacy);
  const first = await buildApplyPlan(await loadWorkspace(root), options);
  assert.equal(first.changes[0].path, path.join(root, ACCESS_POLICY_FILE));
  await applyPlan(first);
  const main = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const access = await fs.readFile(path.join(root, ACCESS_POLICY_FILE), 'utf8');
  assert.match(main, /Keep my editorial rules/);
  assert.match(main, /Tail policy remains/);
  assert.ok(main.endsWith(legacy), 'First Apply must retain the complete original AGENTS.md, including its inline registry');
  assert.match(access, /\/\/ Keep my access annotation/);
  assert.deepEqual(readAccessRegistry(main, access)?.metadata, { owner: 'local' });
  const reloaded = await loadWorkspace(root);
  reloaded.registry.submodules.project.enabled = false;
  const update = await buildApplyPlan(reloaded, { ...options, generateCodexProfile: false });
  assert.deepEqual(update.changes.map(change => change.path), [path.join(root, ACCESS_POLICY_FILE)]);
  assert.ok(update.checks?.some(check => check.path === path.join(root, 'AGENTS.md')), 'Unchanged reference remains a conflict-checked input');
  await applyPlan(update);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), main);
  const updated = await loadWorkspace(root);
  assert.equal(updated.registry.submodules.project.enabled, false);
  assert.match(main, /"enabled": true/, 'The preserved historical registry must not reactivate a disabled sidecar project');
  await restoreChanges(first.changes).then(() => assert.fail('A changed policy must prevent restoring an older application'), error => {
    assert.match(String(error), /changed|match/i);
  });
});

test('Both changed and unchanged sidecars are protected against external edits', async (t) => {
  for (const changePolicy of [false, true]) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry()));
    await applyPlan(await buildApplyPlan(await loadWorkspace(root), options));
    const state = await loadWorkspace(root);
    const settings = path.join(root, '.vscode', 'settings.json');
    const originalSettings = await fs.readFile(settings, 'utf8');
    state.hidden.project = true;
    if (changePolicy) state.registry.submodules.project.enabled = false;
    const plan = await buildApplyPlan(state, options);
    const target = path.join(root, ACCESS_POLICY_FILE);
    const userEdit = (await fs.readFile(target, 'utf8')) + '\nUser policy annotation.\n';
    await fs.writeFile(target, userEdit);
    await assert.rejects(applyPlan(plan), /changed.*refresh/i);
    assert.equal(await fs.readFile(target, 'utf8'), userEdit);
    assert.equal(await fs.readFile(settings, 'utf8'), originalSettings);
  }
});

test('A sidecar created externally after loading cannot be overwritten by first Apply', async (t) => {
  const { root } = await fixture(t);
  const state = await loadWorkspace(root);
  await fs.mkdir(path.join(root, '.agentscope'));
  const target = path.join(root, ACCESS_POLICY_FILE);
  await fs.writeFile(target, 'User-owned notes.\n');
  const plan = await buildApplyPlan(state, options);
  await assert.rejects(applyPlan(plan), /changed.*refresh/i);
  assert.equal(await fs.readFile(target, 'utf8'), 'User-owned notes.\n');
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('Sidecar directory links and directory collisions are refused before writes', async (t) => {
  const { root, outside } = await fixture(t);
  const state = await loadWorkspace(root);
  const plan = await buildApplyPlan(state, options);
  await directoryLink(outside, path.join(root, '.agentscope'));
  await assert.rejects(applyPlan(plan), /symbolic link|junction|parent changed/i);
  await assert.rejects(loadWorkspace(root), /symbolic link|junction/i);
  await assert.rejects(buildApplyPlan(state, options), /symbolic link|junction/i);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await fs.unlink(path.join(root, '.agentscope'));
  await fs.mkdir(path.join(root, ACCESS_POLICY_FILE), { recursive: true });
  await assert.rejects(loadWorkspace(root), /regular file/i);
});

test('A managed reference cannot fall back to a legacy registry when its sidecar is missing', async (t) => {
  const { root } = await fixture(t);
  const generated = writeAccessFiles('', null, emptyRegistry());
  await fs.writeFile(path.join(root, 'AGENTS.md'), generated.agents);
  await assert.rejects(loadWorkspace(root), /missing|not found|requires/i);
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, ACCESS_POLICY_FILE), 'Unrelated user-owned policy.');
  await assert.rejects(loadWorkspace(root), /managed|registry|policy/i);
});

test('A failed reference write rolls back the new sidecar and preserves original instructions', async (t) => {
  const { root } = await fixture(t);
  const main = path.join(root, 'AGENTS.md');
  const original = 'My existing workspace instructions.\n';
  await fs.writeFile(main, original);
  const plan = await buildApplyPlan(await loadWorkspace(root), { ...options, generateCodexProfile: false });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    if (String(target) === main) throw new Error('Injected reference write failure');
    await rename(source, target);
  });
  await assert.rejects(applyPlan(plan), /Injected reference write failure/);
  assert.equal(await fs.readFile(main, 'utf8'), original);
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), ['AGENTS.md']);
});


test('Plain container workspaces discover immediate ordinary folders and keep loose files as resources', async (t) => {
  const { root, outside } = await fixture(t);
  for (const directory of ['Alpha/src', 'Beta', '.cache', 'node_modules', '__pycache__', '.vscode']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'Alpha', 'src', 'hidden-content.ts'), 'Project content must not be scanned.\n');
  await fs.writeFile(path.join(root, 'README.md'), 'Shared workspace notes.\n');
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ "files.exclude": { "Beta": true } }');
  await directoryLink(outside, path.join(root, 'Linked'));
  const readdir = fs.readdir.bind(fs);
  const enumerated: string[] = [];
  const listing = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    enumerated.push(String(args[0]));
    assert.equal(String(args[0]), root, 'Initial discovery must never recurse into projects or linked folders');
    return readdir(...args);
  });
  const state = await loadWorkspace(root);
  assert.deepEqual(state.registry.submodules, {
    Alpha: project({ path: 'Alpha', enabled: false, read_paths: [], write_paths: [] }),
    Beta: project({ path: 'Beta', enabled: false, read_paths: [], write_paths: [] }),
  });
  assert.deepEqual(enumerated, [root]);
  assert.equal(state.hidden.Beta, true);
  assert.equal(state.dirty, false);
  listing.mock.restore();
  state.registry.shared_resources = await toggleResourceSelection(root, state.registry, 'README.md', 'read', true, false);
  assert.deepEqual(state.registry.shared_resources.read_paths, ['README.md']);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('Ordinary project manifests and Git roots keep their own folders within one root project', async (t) => {
  for (const marker of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Example.sln', '.git']) {
    await t.test(marker, async (child) => {
      const { root } = await fixture(child);
      await fs.mkdir(path.join(root, 'src'));
      await fs.mkdir(path.join(root, 'docs'));
      if (marker === '.git') await fs.mkdir(path.join(root, marker));
      else await fs.writeFile(path.join(root, marker), 'Root project manifest.\n');
      const state = await loadWorkspace(root);
      assert.deepEqual(Object.values(state.registry.submodules), [project({ path: '.', enabled: false, read_paths: [], write_paths: [] })]);
    });
  }
});

test('Saved ordinary and explicitly empty registrations do not trigger folder discovery', async (t) => {
  for (const saved of [emptyRegistry(), { ...emptyRegistry(), submodules: { selected: project({ path: 'Alpha', enabled: false }) } }]) {
    const { root } = await fixture(t);
    await fs.mkdir(path.join(root, 'Alpha'));
    await fs.mkdir(path.join(root, 'Unregistered'));
    await fs.writeFile(path.join(root, 'AGENTS.md'), policy(saved));
    const readdir = t.mock.method(fs, 'readdir', async () => { throw new Error('Saved registration must not enumerate workspace folders'); });
    try { assert.deepEqual((await loadWorkspace(root)).registry, saved); }
    finally { readdir.mock.restore(); }
  }
});

test('Applying discovered folder scopes keeps a sibling project disabled and preserves root resources', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'Alpha'));
  await fs.mkdir(path.join(root, 'Beta'));
  await fs.writeFile(path.join(root, 'Alpha', 'chosen.md'), 'Selected leaf.\n');
  await fs.writeFile(path.join(root, 'Beta', 'private.md'), 'Disabled sibling.\n');
  await fs.writeFile(path.join(root, 'README.md'), 'Root notes.\n');
  const state = await loadWorkspace(root);
  state.registry.submodules.Alpha.enabled = true;
  state.registry.submodules.Alpha.read_paths = ['chosen.md'];
  state.registry.shared_resources.read_paths = ['README.md'];
  state.hidden.Beta = true;
  await applyPlan(await buildApplyPlan(state, options));
  const saved = await loadWorkspace(root);
  assert.deepEqual(saved.registry, state.registry);
  assert.equal(saved.registry.submodules.Beta.enabled, false);
  assert.deepEqual(saved.registry.submodules.Beta.read_paths, []);
  assert.equal(saved.hidden.Beta, true);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'Root notes.\n');
  assert.equal(await fs.readFile(path.join(root, 'Beta', 'private.md'), 'utf8'), 'Disabled sibling.\n');
  const scopes = filesystem(await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8'));
  assert.equal(scopes[path.join(root, 'Alpha', 'chosen.md')], 'read');
  assert.equal(scopes[path.join(root, 'README.md')], 'read');
  assert.equal(scopes[path.join(root, 'Beta')], 'deny');
  assert.equal(scopes[path.join(root, 'Alpha')], undefined);
  assert.deepEqual((await buildApplyPlan(saved, options)).changes, []);
});
