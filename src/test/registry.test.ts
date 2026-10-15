import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { generateProfile } from '../core/profile';
import { emptyRegistry, parseGitmodules, parseJsoncStrict, readAgentsRegistry, validateRegistry, writeAgentsRegistry } from '../core/registry';
import { project, registry, policy, fixture } from './helpers';
import { loadWorkspace, buildApplyPlan } from '../workspace';
import { toggleWorkspaceSelection } from '../resources';

test('Git submodule discovery supports names distinct from paths and quoted spaces', () => {
  const modules = parseGitmodules('[submodule "research-engine"]\n path = "packages/research engine" # local comment\n url = private-url\n[submodule "docs"]\n path = documentation\n');
  assert.deepEqual(modules, [{ name: 'research-engine', path: 'packages/research engine' }, { name: 'docs', path: 'documentation' }]);
  assert.throws(() => parseGitmodules('[submodule "bad"]\n path = ../other\n'), /parent|traverse/);
  assert.throws(() => parseGitmodules('[submodule "one"]\n path = same\n[submodule "two"]\n path = same\n'), /Duplicate/);
});

test('Git submodule discovery decodes continuations, mixed quotes and unquoted comments', () => {
  const manifest = '[submodule "continued"]\r\npath = secret\\\r\nprojects\r\n' +
    '[submodule "mixed"]\npath = secret" projects"# comment without a separating space\n' +
    '[submodule "symbols"]\npath = folder"#;"name ; outside comment\n' +
    '[submodule.OLD]\npath = old-project\n';
  assert.deepEqual(parseGitmodules(manifest), [
    { name: 'continued', path: 'secretprojects' },
    { name: 'mixed', path: 'secret projects' },
    { name: 'symbols', path: 'folder#;name' },
    { name: 'old', path: 'old-project' },
  ]);
});

test('Invalid or unsupported manifest syntax fails closed instead of dropping projects', () => {
  for (const manifest of [
    '[submodule "child"\npath = secret\n',
    '[submodule "child"] extra\npath = secret\n',
    '[submodule]\npath = secret\n',
    '[submodule "child"]\nurl = private-url\n',
    '[submodule "child"]\npath\n',
    '[submodule "child"]\npath = "secret\n',
    '[submodule "child"]\npath = secret\\q\n',
    '[submodule "child"]\npath = secret\\\\projects\n',
    '[submodule "child"]\npath = secret\nnot a property\n',
    '[include]\npath = other-config\n',
    'path = secret\n',
  ]) { assert.throws(() => parseGitmodules(manifest), /gitmodules|submodule/i, manifest); }
});

test('A continued disabled project remains excluded from Workspace files Write selection', async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'secretprojects'));
  await mkdir(path.join(root, 'secret'));
  await writeFile(path.join(root, '.gitmodules'), '[submodule "child"]\npath = secret\\\nprojects\n');
  const state = await loadWorkspace(root);
  assert.equal(state.registry.submodules.child.path, 'secretprojects');
  assert.equal(state.registry.submodules.child.enabled, false);
  state.registry.shared_resources = await toggleWorkspaceSelection(root, state.registry, 'write', true);
  assert.ok(state.registry.shared_resources.write_paths.includes('secret'));
  assert.ok(!state.registry.shared_resources.write_paths.includes('secretprojects'));
  const plan = await buildApplyPlan(state, { generateCodexProfile: true, excludeFromSearch: true, profileName: 'agentscope', allowNetwork: false, codexFilesystemMode: 'strict' });
  const config = plan.changes.find(change => change.path === path.join(root, '.codex', 'config.toml'))!;
  const parsed = TOML.parse(config.after) as any;
  assert.equal(parsed.permissions.agentscope.filesystem[path.join(root, 'secretprojects')], 'deny');
  assert.equal(parsed.permissions.agentscope.filesystem[path.join(root, 'secret')], 'write');
});

test('Absent registry returns null; adding one retains existing policy text', () => {
  const existing = '# My policy\n\nUse my existing instructions.\n\n```json\n{"unrelated": true}\n```\n';
  assert.equal(readAgentsRegistry(existing), null);
  const written = writeAgentsRegistry(existing, emptyRegistry());
  assert.ok(written.startsWith(existing));
  assert.match(written, /BEGIN AgentScope managed instructions/);
  assert.deepEqual(readAgentsRegistry(written), emptyRegistry());
  assert.equal(writeAgentsRegistry(written, emptyRegistry()), written);
});

test('Registry reads fail closed when booleans are missing or have the wrong type', () => {
  const input = { shared_resources: {}, submodules: { project: { path: 'project', enabled: 'true', restrict_paths: null } } };
  const read = readAgentsRegistry(policy(input))!;
  assert.equal(read.submodules.project.enabled, false);
  assert.equal(read.submodules.project.restrict_paths, true);
  assert.deepEqual(read.submodules.project.read_paths, []);
  assert.deepEqual(read.submodules.project.write_paths, []);
  assert.equal(read.submodules.project.instruction_file, null);
});

test('Literal prototype metadata cannot enable a project or generate a broad write grant', () => {
  const input = policy(JSON.parse('{"shared_resources":{},"submodules":{"project":{"path":"project","__proto__":{"enabled":true,"restrict_paths":false,"read_paths":["."],"write_paths":["."]}}}}'));
  const read = readAgentsRegistry(input)!;
  assert.equal(read.submodules.project.enabled, false);
  assert.equal(read.submodules.project.restrict_paths, true);
  assert.deepEqual(read.submodules.project.read_paths, []);
  assert.deepEqual(read.submodules.project.write_paths, []);
  const root = path.resolve('prototype-registry-fixture');
  const profile = TOML.parse(generateProfile(read, { root, profileName: 'agentscope', allowNetwork: false, filesystemMode: 'strict' }).text) as any;
  assert.equal(profile.permissions.agentscope.filesystem[path.join(root, 'project')], 'deny');
});

test('A prototype metadata restriction cannot broaden an explicitly enabled project', () => {
  const input = policy(JSON.parse('{"shared_resources":{},"submodules":{"project":{"path":"project","enabled":true,"__proto__":{"restrict_paths":false,"read_paths":["."]},"write_paths":["drafts"]}}}'));
  const read = readAgentsRegistry(input)!;
  assert.equal(read.submodules.project.enabled, true);
  assert.equal(read.submodules.project.restrict_paths, true);
  assert.deepEqual(read.submodules.project.read_paths, []);
  assert.deepEqual(read.submodules.project.write_paths, ['drafts']);
  const root = path.resolve('prototype-registry-fixture');
  const profile = TOML.parse(generateProfile(read, { root, profileName: 'agentscope', allowNetwork: false }).text) as any;
  assert.equal(profile.permissions.agentscope.filesystem[path.join(root, 'project')], undefined);
  assert.equal(profile.permissions.agentscope.filesystem[path.join(root, 'project', 'drafts')], 'write');
});

test('JSONC retains prototype-named user metadata as own data and persists fail-closed defaults', () => {
  const raw = '{"__proto__":{"description":"retain root metadata"},"nested":[{"__proto__":{"enabled":true}}]}';
  const parsed = parseJsoncStrict(raw, 'Metadata') as Record<string, any>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(parsed.description, undefined);
  assert.equal(Object.getPrototypeOf(parsed.nested[0]), Object.prototype);
  assert.equal(parsed.nested[0].enabled, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(raw));

  const input = policy(JSON.parse('{"shared_resources":{},"submodules":{"project":{"path":"project","__proto__":{"enabled":true,"restrict_paths":false},"note":"retain"}}}'));
  const output = writeAgentsRegistry(input, readAgentsRegistry(input)!);
  const written = parseJsoncStrict(/```json\r?\n([\s\S]*?)\r?\n```/.exec(output)![1], 'Written registry') as any;
  assert.equal(Object.hasOwn(written.submodules.project, 'enabled'), true);
  assert.equal(written.submodules.project.enabled, false);
  assert.equal(written.submodules.project.restrict_paths, true);
  assert.deepEqual(written.submodules.project.__proto__, { enabled: true, restrict_paths: false });
  assert.equal(written.submodules.project.note, 'retain');
});

test('Prototype keys cannot hide reserved project names or supply missing registry objects', () => {
  assert.throws(() => readAgentsRegistry(policy(JSON.parse('{"shared_resources":{},"submodules":{"__proto__":{"path":"project"}}}'))), /Unsupported module name/);
  assert.throws(() => readAgentsRegistry(policy(JSON.parse('{"shared_resources":{},"__proto__":{"submodules":{"project":{"path":"project","enabled":true,"restrict_paths":false}}}}'))), /must contain shared_resources and submodules/);
  assert.throws(() => parseJsoncStrict('{"__proto__":{},"\\u005f_proto__":{}}', 'Metadata'), /duplicate JSON key/);
});

test('Registry changes preserve prose, unknown metadata and comments in JSONC', () => {
  const input = '# My policy\r\n\r\n```jsonc\r\n{\r\n  // Keep this description\r\n  "metadata": { "owner": "local" },\r\n  "shared_resources": { "read_paths": ["Instructions"], "write_paths": [], "custom": 7 },\r\n  "submodules": {\r\n    "project": { "path": "project", "enabled": false, "restrict_paths": true, "read_paths": [], "write_paths": [], "instruction_file": null, "note": "keep" }\r\n  }\r\n}\r\n```\r\n\r\nTail stays byte-for-byte.\r\n';
  const value = readAgentsRegistry(input)!;
  value.submodules.project.enabled = true;
  value.submodules.project.write_paths = ['drafts'];
  const updated = writeAgentsRegistry(input, value);
  assert.ok(updated.startsWith('# My policy\r\n\r\n```jsonc\r\n'));
  assert.ok(updated.endsWith('```\r\n\r\nTail stays byte-for-byte.\r\n'));
  assert.match(updated, /\/\/ Keep this description/);
  const read = readAgentsRegistry(updated)!;
  assert.deepEqual(read.metadata, { owner: 'local' });
  assert.equal(read.shared_resources.custom, 7);
  assert.equal(read.submodules.project.note, 'keep');
  assert.deepEqual(read.submodules.project.write_paths, ['drafts']);
});

test('Malformed, duplicate-key and multiple registries never silently grant access', () => {
  assert.throws(() => readAgentsRegistry('```json\n{"shared_resources": {}, "submodules": {\n```'), /invalid JSON/);
  assert.throws(() => readAgentsRegistry('```json\n{"shared_resources": {}, "submodules": {}, "submodules": {}}\n```'), /duplicate JSON key/);
  assert.throws(() => readAgentsRegistry(policy(registry()) + policy(registry())), /multiple scope registries/);
  assert.throws(() => readAgentsRegistry('```json\n{"shared_resources": {}, "submodules": {}}'), /not closed/);
});

test('Registry rejects overlapping projects, shared-resource bypasses and unreadable instructions', () => {
  assert.throws(() => validateRegistry(registry({ child: project({ path: 'project/private', enabled: false }) })), /overlap/i);
  const bypass = registry({ disabled: project({ path: 'secret', enabled: false }) });
  bypass.shared_resources.read_paths = ['secret'];
  assert.throws(() => validateRegistry(bypass), /shared|overlap/i);
  assert.throws(() => validateRegistry(registry({ project: project({ instruction_file: 'unreadable/workflow.md' }) })), /instruction|readable/i);
  const valid = registry({ project: project({ instruction_file: 'project/drafts/workflow.md' }) });
  assert.doesNotThrow(() => validateRegistry(valid));
  valid.submodules.project.instruction_file = 'Instructions/Writer.md';
  assert.doesNotThrow(() => validateRegistry(valid));
});

test('Absolute paths and patterns cannot replace a bounded project scope', () => {
  for (const value of ['/private', 'C:\\private', '../private', 'project/**']) {
    assert.throws(() => validateRegistry(registry({ project: project({ path: value }) })));
  }
});

test('Access registries cannot grant Git metadata through project roots, scopes or shared resources', () => {
  const metadataPaths = ['.git', '.git/config', 'nested/.git', 'nested/.git/config'];
  if (process.platform === 'win32') metadataPaths.push('.Git/config', 'nested/.GIT/config');
  for (const metadataPath of metadataPaths) {
    assert.throws(() => validateRegistry(registry({ project: project({ path: metadataPath }) })), /Git metadata/);
    for (const field of ['read_paths', 'write_paths'] as const) {
      assert.throws(() => validateRegistry(registry({ project: project({ [field]: [metadataPath] }) })), /Git metadata/);
      const shared = emptyRegistry();
      shared.shared_resources[field] = [metadataPath];
      assert.throws(() => validateRegistry(shared), /Git metadata/);
    }
  }
  const ordinary = emptyRegistry();
  ordinary.submodules.workspace = project({ path: '.', read_paths: [], write_paths: ['.'] });
  assert.doesNotThrow(() => validateRegistry(ordinary));
  const supporting = emptyRegistry();
  supporting.shared_resources.read_paths = ['.gitmodules', '.github'];
  assert.doesNotThrow(() => validateRegistry(supporting));
});

test('A sole ordinary workspace project supports precise root-relative scopes', () => {
  const value = emptyRegistry();
  value.submodules.repository = project({ path: '.', read_paths: ['./src'], write_paths: [], instruction_file: 'src/workflow.md' });
  assert.doesNotThrow(() => validateRegistry(value));
  value.submodules.child = project({ path: 'child', enabled: false });
  assert.throws(() => validateRegistry(value), /overlap/i);
  delete value.submodules.child;
  value.shared_resources.read_paths = ['Instructions'];
  assert.throws(() => validateRegistry(value), /shared|overlap/i);
});
