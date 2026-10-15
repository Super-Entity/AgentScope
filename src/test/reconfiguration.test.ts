import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { ACCESS_POLICY_FILE, emptyRegistry, writeAccessFiles } from '../core/registry';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from '../configuration';
import { togglePathSelection } from '../core/selection';
import { applyPlan, restoreChanges } from '../transactions';
import { ApplyOptions, buildApplyPlan, loadWorkspace, loadWorkspaceForReconfiguration } from '../workspace';
import { directoryLink, fixture, policy, project, registry } from './helpers';

const options: ApplyOptions = { generateCodexProfile: false, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false };
const begin = '<!-- BEGIN AgentScope access reference -->';
const end = '<!-- END AgentScope access reference -->';

test('Explicit reconfiguration preserves malformed and customized instruction blocks without regenerating policy files', async (t) => {
  const originals = [
    `${begin}\nAlways keep my custom instruction.\n${end}\nTail instructions.`,
    `${begin}\nDo not remove my prose.\n`,
    '<!-- BEGIN AgentScope access reference --\nMy damaged comment text.\n',
    `${end}\nKeep this reversed block.\n${begin}\n`,
    `<!-- BEGIN AgentScope access policy -->\nMy custom policy rules.\n<!-- END AgentScope access policy -->`,
  ];
  for (const original of originals) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'AGENTS.md'), original);
    const state = await loadWorkspaceForReconfiguration(root);
    const plan = await buildApplyPlan(state, options);
    assert.ok(!plan.changes.some(change => change.path === path.join(root, 'AGENTS.md')));
    await applyPlan(plan);
    assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), original);
    assert.deepEqual((await loadWorkspace(root)).registry, state.registry);
    await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
    assert.deepEqual((await buildApplyPlan(await loadWorkspace(root), options)).changes, []);
  }
});

test('Explicit reconfiguration retains unmarked historical registry bytes even when its JSON is invalid', async (t) => {
  const { root } = await fixture(t);
  const original = '# My instructions\r\n\r\n```jsonc\r\n{ "submodules": { BROKEN, "shared_resources": {} }\r\n```\r\n\r\nKeep my final instruction.\r\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), '\uFEFF' + original);
  await applyPlan(await buildApplyPlan(await loadWorkspaceForReconfiguration(root), options));
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), '\uFEFF' + original);
  assert.ok(await fs.stat(path.join(root, SCOPE_CONFIGURATION_FILE)));
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('Configuration repair ignores marker-looking lines inside fenced user examples', async (t) => {
  const { root } = await fixture(t);
  const example = '````markdown\n<!-- BEGIN AgentScope access reference --\n```json\n{"submodules": BROKEN}\n```\n' + end + '\n````\n\n~~~text\n' + begin + '\n~~~\n';
  const original = begin + '\nKeep my outside custom text.\n' + end + '\n\n' + example;
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  await applyPlan(await buildApplyPlan(await loadWorkspaceForReconfiguration(root), options));
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), original);
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('Known references are detached without removing any byte from the user suffix or changing the old sidecar', async (t) => {
  const { root } = await fixture(t);
  const initial = writeAccessFiles('# User instructions\n\nLast line without newline', null, emptyRegistry());
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), initial.agents);
  await fs.writeFile(path.join(root, ACCESS_POLICY_FILE), initial.access);
  const state = await loadWorkspaceForReconfiguration(root);
  await applyPlan(await buildApplyPlan(state, options));
  const expected = initial.agents.slice(initial.agents.indexOf(end) + end.length);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), expected);
  assert.equal(await fs.readFile(path.join(root, ACCESS_POLICY_FILE), 'utf8'), initial.access);
  assert.deepEqual(readScopeConfiguration(await fs.readFile(path.join(root, SCOPE_CONFIGURATION_FILE), 'utf8')), state.registry);
});

test('Two missing policy files produce a disabled fresh workspace project without filesystem writes', async (t) => {
  const { root } = await fixture(t);
  const state = await loadWorkspaceForReconfiguration(root);
  assert.equal(state.reconfigurePolicy, true);
  assert.equal(state.dirty, true);
  assert.deepEqual(state.registry.shared_resources, { read_paths: [], write_paths: [] });
  assert.deepEqual(Object.values(state.registry.submodules), [project({ path: '.', enabled: false, read_paths: [], write_paths: [] })]);
  assert.equal(state.files?.[path.join(root, 'AGENTS.md')], null);
  assert.equal(state.files?.[path.join(root, ACCESS_POLICY_FILE)], null);
  assert.deepEqual(await fs.readdir(root), []);
  await applyPlan(await buildApplyPlan(state, options));
  const loaded = await loadWorkspace(root);
  assert.deepEqual(loaded.registry, state.registry);
  assert.equal(loaded.reconfigurePolicy, undefined);
});

test('Healthy checkpoint, legacy policy and manifest contribute registration roots but never old grants', async (t) => {
  const { root } = await fixture(t);
  const checkpoint = registry({ fromCheckpoint: project({ path: 'saved', restrict_paths: false, instruction_file: 'Instructions/workflow.md' }) });
  checkpoint.submodules.project.instruction_file = 'Instructions/workflow.md';
  await fs.writeFile(path.join(root, 'AGENTS.md'), policy(registry({ fromMain: project({ path: 'legacy' }) })));
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "fromManifest"]\n path = discovered\n url = local://project\n');
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ "files.exclude": { "saved": true }, "editor.tabSize": 3 }');
  const state = await loadWorkspaceForReconfiguration(root, checkpoint);
  assert.deepEqual(Object.keys(state.registry.submodules).sort(), ['fromCheckpoint', 'fromMain', 'fromManifest', 'project']);
  for (const module of Object.values(state.registry.submodules)) {
    assert.equal(module.enabled, false);
    assert.equal(module.restrict_paths, true);
    assert.deepEqual(module.read_paths, []);
    assert.deepEqual(module.write_paths, []);
    assert.equal(module.instruction_file, null);
  }
  assert.deepEqual(state.registry.shared_resources, { read_paths: [], write_paths: [] });
  assert.equal(state.hidden.fromCheckpoint, true);
  assert.equal(checkpoint.submodules.fromCheckpoint.enabled, true);
  assert.equal(checkpoint.submodules.fromCheckpoint.instruction_file, 'Instructions/workflow.md');
});

test('Healthy sidecar registration survives a corrupted main policy, without restoring access', async (t) => {
  const { root } = await fixture(t);
  const saved = writeAccessFiles('', null, registry());
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, ACCESS_POLICY_FILE), saved.access);
  const damaged = begin + '\nNever delete this custom instruction.\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), damaged);
  const state = await loadWorkspaceForReconfiguration(root);
  assert.equal(state.registry.submodules.project.enabled, false);
  assert.deepEqual(state.registry.submodules.project.read_paths, []);
  assert.equal(state.files?.[path.join(root, 'AGENTS.md')], damaged);
  assert.equal(state.files?.[path.join(root, ACCESS_POLICY_FILE)], saved.access);
});

test('Repair Apply grants exactly the newly checked leaf and retains conflicting main prose and the old sidecar', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(root, 'project', 'chosen.md'), 'Chosen\n');
  await fs.writeFile(path.join(root, 'project', 'untouched.md'), 'Untouched\n');
  const original = policy(registry({ project: project({ restrict_paths: false }) }), '# Custom instructions\nAlways keep these rules.\n');
  const corruptAccess = 'User explanation and damaged sidecar JSON: { "submodules": BROKEN }\n';
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  await fs.writeFile(path.join(root, ACCESS_POLICY_FILE), corruptAccess);
  await assert.rejects(loadWorkspace(root), /managed policy/);
  const state = await loadWorkspaceForReconfiguration(root);
  state.registry.submodules.project = await togglePathSelection(state.registry.submodules.project, 'chosen.md', 'write', true,
    async () => [{ relative: 'chosen.md', directory: false }, { relative: 'untouched.md', directory: false }]);
  const plan = await buildApplyPlan(state, options);
  assert.ok(!plan.changes.some(change => change.path === path.join(root, ACCESS_POLICY_FILE)));
  assert.equal(plan.changes.find(change => change.path === path.join(root, SCOPE_CONFIGURATION_FILE))?.before, null);
  await applyPlan(plan);
  const main = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(main, original);
  assert.equal(await fs.readFile(path.join(root, ACCESS_POLICY_FILE), 'utf8'), corruptAccess);
  const loaded = await loadWorkspace(root);
  assert.deepEqual(loaded.registry.submodules.project, project({ read_paths: [], write_paths: ['chosen.md'] }));
  assert.deepEqual(loaded.registry.shared_resources, { read_paths: [], write_paths: [] });
  assert.equal(await fs.readFile(path.join(root, 'project', 'untouched.md'), 'utf8'), 'Untouched\n');
  await restoreChanges(plan.changes);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(root, ACCESS_POLICY_FILE), 'utf8'), corruptAccess);
});

test('Reconfiguration snapshots reject concurrent policy changes before any writes', async (t) => {
  const { root } = await fixture(t);
  const damaged = begin + '\nUser custom instruction.\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), damaged);
  const state = await loadWorkspaceForReconfiguration(root);
  const plan = await buildApplyPlan(state, options);
  const competing = 'A newer user instruction must survive.\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), competing);
  await assert.rejects(applyPlan(plan), /changed|conflict/i);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), competing);
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
});

test('A fresh repair draft cannot apply to an ordinary replacement of its loaded root', async (t) => {
  const { root } = await fixture(t);
  const original = begin + '\nPreserve this malformed-policy prose.\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  const state = await loadWorkspaceForReconfiguration(root);
  assert.ok(state.rootIdentity);
  const plan = await buildApplyPlan(state, options);
  await fs.rename(root, root + '-original');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  await assert.rejects(buildApplyPlan(state, options), /root directory changed.*refresh/i);
  await assert.rejects(applyPlan(plan), /root directory changed.*refresh/i);
  assert.deepEqual(await fs.readdir(root), ['AGENTS.md']);
  assert.equal(await fs.readFile(path.join(root + '-original', 'AGENTS.md'), 'utf8'), original);
});

test('Explicit repair still rejects linked config directories and nonregular policy targets', async (t) => {
  const { root, outside } = await fixture(t);
  await directoryLink(outside, path.join(root, '.agentscope'));
  await assert.rejects(loadWorkspaceForReconfiguration(root), /symbolic link|junction/i);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, '.agentscope'));
  await fs.mkdir(path.join(root, 'AGENTS.md'));
  await assert.rejects(loadWorkspaceForReconfiguration(root), /regular file/i);
});

test('Invalid editor settings and duplicate manifest paths are still rejected during repair', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ "files.exclude": BROKEN }');
  await assert.rejects(loadWorkspaceForReconfiguration(root), /invalid JSON/i);
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{}');
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "one"]\npath = project\n[submodule "two"]\npath = project\n');
  await assert.rejects(loadWorkspaceForReconfiguration(root), /Duplicate or invalid submodule root/);
});

test('Conflicting or overlapping registration metadata stops repair instead of selecting an arbitrary root', async (t) => {
  const { root } = await fixture(t);
  const checkpoint = registry();
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "project"]\npath = moved\n');
  await assert.rejects(loadWorkspaceForReconfiguration(root, checkpoint), /Ambiguous project registration/);
  await fs.writeFile(path.join(root, '.gitmodules'), '[submodule "nested"]\npath = project/nested\n');
  await assert.rejects(loadWorkspaceForReconfiguration(root, checkpoint), /Ambiguous overlapping project roots/);
  const invalid = registry({ extra: project({ path: 'project/nested' }) });
  await assert.rejects(loadWorkspaceForReconfiguration(root, invalid), /Project roots overlap/);
  assert.deepEqual(await fs.readdir(root), ['.gitmodules']);
});


test('Fresh access reconfiguration discovers ordinary sibling projects without old grants', async (t) => {
  const { root, outside } = await fixture(t);
  await fs.mkdir(path.join(root, 'Alpha'));
  await fs.mkdir(path.join(root, 'Beta'));
  await fs.mkdir(path.join(root, '.cache'));
  await fs.writeFile(path.join(root, 'README.md'), 'Workspace resource.\n');
  await directoryLink(outside, path.join(root, 'Linked'));
  const state = await loadWorkspaceForReconfiguration(root);
  assert.deepEqual(state.registry.submodules, {
    Alpha: project({ path: 'Alpha', enabled: false, read_paths: [], write_paths: [] }),
    Beta: project({ path: 'Beta', enabled: false, read_paths: [], write_paths: [] }),
  });
  assert.deepEqual(state.registry.shared_resources, { read_paths: [], write_paths: [] });
  assert.equal(state.reconfigurePolicy, true);
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  await applyPlan(await buildApplyPlan(state, options));
  assert.deepEqual((await loadWorkspace(root)).registry, state.registry);
});

test('New editor configuration supplies repair registration and leaves all old grants disabled', async (t) => {
  const { root } = await fixture(t);
  const saved = registry();
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, SCOPE_CONFIGURATION_FILE), writeScopeConfiguration(null, saved));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Unclosed legacy controls are irrelevant after migration.\n<!-- BEGIN AgentScope access reference -->\n');
  const state = await loadWorkspaceForReconfiguration(root);
  assert.deepEqual(state.registry.submodules.project, project({ enabled: false, read_paths: [], write_paths: [] }));
  assert.deepEqual(state.registry.shared_resources, { read_paths: [], write_paths: [] });
  await applyPlan(await buildApplyPlan(state, options));
  assert.deepEqual((await loadWorkspace(root)).registry, state.registry);
});

test('Repair can replace malformed editor configuration and Restore recovers its exact bytes', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const target = path.join(root, SCOPE_CONFIGURATION_FILE);
  const malformed = '// Keep this damaged state for Restore\n{"version":1,"registry":BROKEN}\n';
  await fs.writeFile(target, malformed);
  await assert.rejects(loadWorkspace(root), /invalid JSON/);
  const state = await loadWorkspaceForReconfiguration(root, registry());
  const plan = await buildApplyPlan(state, options);
  assert.equal(plan.changes.find(change => change.path === target)?.before, malformed);
  await applyPlan(plan);
  assert.equal((await loadWorkspace(root)).registry.submodules.project.enabled, false);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, ACCESS_POLICY_FILE)), { code: 'ENOENT' });
  await restoreChanges(plan.changes);
  assert.equal(await fs.readFile(target, 'utf8'), malformed);
});

test('Concurrent editor-state changes stop reconfiguration before any write', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const target = path.join(root, SCOPE_CONFIGURATION_FILE);
  const original = writeScopeConfiguration(null, registry());
  await fs.writeFile(target, original);
  const plan = await buildApplyPlan(await loadWorkspaceForReconfiguration(root), options);
  const competing = original + '// A competing editor changed this state.\n';
  await fs.writeFile(target, competing);
  await assert.rejects(applyPlan(plan), /changed|conflict/i);
  assert.equal(await fs.readFile(target, 'utf8'), competing);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});
