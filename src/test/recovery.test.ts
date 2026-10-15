import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from '../configuration';
import { ACCESS_POLICY_FILE, writeAccessFiles } from '../core/registry';
import { buildPolicyRecoveryPlan, checkpointFromLastApply, checkpointKey, createCheckpoint, PolicyCheckpoint, validateCheckpoint } from '../recovery';
import { applyPlan, restoreChanges } from '../transactions';
import { FileChange, WorkspaceState } from '../types';
import { directoryLink, fixture, registry } from './helpers';

const timestamp = '2026-01-02T03:04:05.000Z';
const targetPath = (root: string): string => path.join(root, ...SCOPE_CONFIGURATION_FILE.split('/'));
function saved(root: string): PolicyCheckpoint {
  return { version: 2, root, configuration: writeScopeConfiguration(null, registry()), savedAt: timestamp };
}
function state(checkpoint: PolicyCheckpoint): WorkspaceState {
  return {
    root: checkpoint.root, registry: readScopeConfiguration(checkpoint.configuration, checkpoint.root),
    hidden: {}, dirty: false, warnings: [], files: { [targetPath(checkpoint.root)]: checkpoint.configuration },
  };
}
async function writeConfiguration(checkpoint: PolicyCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(targetPath(checkpoint.root)), { recursive: true });
  await fs.writeFile(targetPath(checkpoint.root), checkpoint.configuration);
}
function outputs(checkpoint: PolicyCheckpoint): FileChange[] {
  return [
    { path: targetPath(checkpoint.root), before: null, after: checkpoint.configuration },
    { path: path.join(checkpoint.root, '.vscode', 'settings.json'), before: null, after: '{}' },
    { path: path.join(checkpoint.root, '.codex', 'config.toml'), before: null, after: '# Generated profile\n' },
  ];
}

test('A checkpoint captures exact persisted editor configuration without mutating state or reading files', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  checkpoint.configuration = '// Keep comments and metadata\n' + checkpoint.configuration;
  const workspace = state(checkpoint);
  workspace.registry.submodules.project.enabled = false;
  const original = JSON.stringify(workspace);
  const captured = createCheckpoint(workspace);
  assert.ok(captured);
  assert.equal(captured.version, 2);
  assert.equal(captured.root, root);
  assert.equal(captured.configuration, checkpoint.configuration);
  assert.equal(readScopeConfiguration(captured.configuration).submodules.project.enabled, true);
  assert.equal(new Date(captured.savedAt).toISOString(), captured.savedAt);
  assert.equal(JSON.stringify(workspace), original);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Draft, missing and malformed configuration snapshots never replace a checkpoint', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  for (const candidate of [
    { ...state(checkpoint), dirty: true }, { ...state(checkpoint), files: undefined }, { ...state(checkpoint), files: {} },
    { ...state(checkpoint), files: { [targetPath(root)]: null } },
    { ...state(checkpoint), files: { [targetPath(root)]: '{broken' } },
    { ...state(checkpoint), files: { [targetPath(root)]: '{"version":2,"registry":{}}' } },
  ]) assert.equal(createCheckpoint(candidate), null);
});

test('Checkpoint validation rejects unknown formats, roots, timestamps and unsafe grants', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  for (const value of [
    null, [], 'snapshot', {}, { ...checkpoint, version: 3 }, { ...checkpoint, extra: true },
    { ...checkpoint, root: outside }, { ...checkpoint, root: 'workspace' },
    { ...checkpoint, root: root + path.sep + '..' + path.sep + 'workspace' },
    { ...checkpoint, savedAt: 'invalid time' }, { ...checkpoint, savedAt: '2026-01-02T03:04:05Z' },
    { ...checkpoint, configuration: '' }, { ...checkpoint, configuration: '{"version":1,"registry":{}}' },
    { ...checkpoint, configuration: checkpoint.configuration.replace('"references"', '"../outside"') },
    { ...checkpoint, configuration: checkpoint.configuration.replace('"enabled": true', '"enabled": true, "enabled": false') },
  ]) assert.throws(() => validateCheckpoint(value, root));
  assert.throws(() => validateCheckpoint(checkpoint, 'relative workspace'), /absolute normalized/);
  assert.deepEqual(validateCheckpoint(checkpoint, root), checkpoint);
});

test('Legacy checkpoints migrate selections while removing instruction-file bindings', async t => {
  const { root } = await fixture(t);
  const selections = registry();
  selections.submodules.project.instruction_file = 'project/references/workflow.md';
  const files = writeAccessFiles('# Custom instructions stay in the old file\n', null, selections);
  const migrated = validateCheckpoint({ version: 1, root, agents: files.agents, access: files.access, savedAt: timestamp }, root);
  assert.equal(migrated.version, 2);
  const imported = readScopeConfiguration(migrated.configuration, root);
  assert.equal(imported.submodules.project.instruction_file, null);
  assert.deepEqual(imported.submodules.project.write_paths, selections.submodules.project.write_paths);
  const plan = await buildPolicyRecoveryPlan(root, migrated);
  assert.deepEqual(plan.changes.map(change => change.path), [targetPath(root)]);
  await applyPlan(plan);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.agentscope')), { code: 'ENOENT' });
});

test('Legacy checkpoint migration rejects incomplete, corrupt and conflicting linked policies', async t => {
  const { root } = await fixture(t);
  const files = writeAccessFiles('', null, registry());
  const legacy = { version: 1, root, agents: files.agents, access: files.access, savedAt: timestamp };
  for (const invalid of [
    { ...legacy, agents: undefined }, { ...legacy, access: '' }, { ...legacy, access: '{broken' },
    { ...legacy, extra: true }, { ...legacy, agents: files.agents.replace('Before reading', 'Changed policy. Before reading') },
  ]) assert.throws(() => validateCheckpoint(invalid, root));
  assert.equal(validateCheckpoint({ ...legacy, agents: '' }, root).version, 2, 'A valid retained sidecar can supply selections when old instructions were deleted.');
});

test('Checkpoint keys remain stable for migration and isolate workspace paths', async t => {
  const { root, outside } = await fixture(t);
  const key = checkpointKey(root);
  assert.match(key, /^agentscope\.policyCheckpoint\.v1\.[a-f0-9]{64}$/);
  assert.equal(checkpointKey(root), key);
  assert.notEqual(checkpointKey(outside), key);
  assert.equal(key.includes(root), false);
  if (process.platform === 'win32') assert.equal(checkpointKey(root.toUpperCase()), key);
  assert.throws(() => checkpointKey('relative workspace'), /absolute normalized/);
});

test('Apply backups bootstrap new configuration or migrate a complete legacy pair without reading files', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  const captured = checkpointFromLastApply(root, outputs(checkpoint));
  assert.ok(captured);
  assert.equal(captured.configuration, checkpoint.configuration);
  assert.ok(checkpointFromLastApply(root, [outputs(checkpoint)[0]]));
  const files = writeAccessFiles('# Retained custom prose\n', null, registry());
  const migrated = checkpointFromLastApply(root, [
    { path: path.join(root, 'AGENTS.md'), before: null, after: files.agents },
    { path: path.join(root, ...ACCESS_POLICY_FILE.split('/')), before: null, after: files.access },
  ]);
  assert.ok(migrated);
  assert.equal(migrated.version, 2);
  assert.deepEqual(readScopeConfiguration(migrated.configuration), registry());
  assert.deepEqual(await fs.readdir(root), []);
});

test('Malformed, duplicate, partial legacy and unrelated backup entries cannot infer a checkpoint', async t => {
  const { root, outside } = await fixture(t);
  const changes = outputs(saved(root));
  for (const value of [
    null, {}, [], changes.slice(1), [...changes, changes[0]],
    [...changes, { path: path.join(root, 'unrelated.txt'), before: null, after: 'text' }],
    [{ ...changes[0], path: path.join(outside, 'agentscope.json') }],
    [{ ...changes[0], before: undefined }], [{ ...changes[0], after: null }],
    [{ ...changes[0], extra: true }], [{ ...changes[0], path: SCOPE_CONFIGURATION_FILE }],
    [{ ...changes[0], after: 'Corrupt output' }],
    [{ path: path.join(root, 'AGENTS.md'), before: null, after: '# Main instructions only' }],
  ]) assert.equal(checkpointFromLastApply(root, value), null);
});

test('Recovery creates only missing editor configuration and creation can be undone', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(plan.changes, [{ path: targetPath(root), before: null, after: checkpoint.configuration }]);
  assert.deepEqual(await fs.readdir(root), []);
  const changes = await applyPlan(plan);
  assert.equal(await fs.readFile(targetPath(root), 'utf8'), checkpoint.configuration);
  assert.deepEqual(await fs.readdir(root), ['.vscode']);
  await restoreChanges(changes);
  await assert.rejects(fs.stat(targetPath(root)), { code: 'ENOENT' });
});

test('Recovery restores corrupt configuration exactly and undo preserves its original bytes', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await fs.mkdir(path.join(root, '.vscode'));
  const corrupted = '// Preserve current text for undo\n{ incomplete registry';
  await fs.writeFile(targetPath(root), corrupted);
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.equal(plan.changes[0].before, corrupted);
  const changes = await applyPlan(plan);
  assert.equal(await fs.readFile(targetPath(root), 'utf8'), checkpoint.configuration);
  await restoreChanges(changes);
  assert.equal(await fs.readFile(targetPath(root), 'utf8'), corrupted);
});

test('Healthy configuration needs no writes but retains input, directory and containment guards', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writeConfiguration(checkpoint);
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.checks, [{ path: targetPath(root), expected: checkpoint.configuration }]);
  assert.equal(plan.pathChecks?.length, 3);
  assert.equal(plan.directoryChecks?.length, 1);
  await applyPlan(plan);
});

test('Recovery rejects another workspace checkpoint before reading configuration', async t => {
  const { root, outside } = await fixture(t);
  let reads = 0;
  t.mock.method(fs, 'readFile', async () => { reads++; throw new Error('Unexpected read'); });
  await assert.rejects(buildPolicyRecoveryPlan(root, saved(outside)), /different workspace/);
  assert.equal(reads, 0);
});

test('Recovery reads only its exact store and ignores instructions and broken unrelated configuration', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writeConfiguration(checkpoint);
  await fs.mkdir(path.join(root, '.codex'));
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{broken settings');
  await fs.writeFile(path.join(root, '.codex', 'config.toml'), '[broken config');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Custom instructions remain untouched');
  await fs.writeFile(path.join(root, '.agentscope', 'access.md'), 'Obsolete corrupt policy');
  const realRead = fs.readFile.bind(fs);
  const reads: string[] = [];
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    reads.push(String(args[0])); return realRead(...args);
  });
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(reads, [targetPath(root)]);
  assert.deepEqual(plan.changes, []);
});

test('Recovery rejects linked store parents with internal or external destinations', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  const parent = path.join(root, '.vscode');
  await directoryLink(outside, parent);
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(parent);
  const internal = path.join(root, 'retained-configuration');
  await fs.mkdir(internal);
  await directoryLink(internal, parent);
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
  assert.deepEqual(await fs.readdir(internal), []);
});

test('Directories and non-directory parents cannot become recovery targets', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await fs.mkdir(targetPath(root), { recursive: true });
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /regular file/);
  await fs.rmdir(targetPath(root));
  await fs.rmdir(path.dirname(targetPath(root)));
  await fs.writeFile(path.join(root, '.vscode'), 'Keep this unrelated file');
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /directory|ENOTDIR/);
  assert.equal(await fs.readFile(path.join(root, '.vscode'), 'utf8'), 'Keep this unrelated file');
});

test('A canonical root cannot become a junction before recovery is planned', async t => {
  const { root, outside } = await fixture(t);
  await fs.rmdir(root);
  await directoryLink(outside, root);
  await assert.rejects(buildPolicyRecoveryPlan(root, saved(root)), /workspace root changed/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Creating or editing store contents after planning preserves the external edit', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing store' : 'missing store', async child => {
    const { root } = await fixture(child);
    const checkpoint = saved(root);
    if (existing) await writeConfiguration(checkpoint);
    const plan = await buildPolicyRecoveryPlan(root, checkpoint);
    await fs.mkdir(path.dirname(targetPath(root)), { recursive: true });
    await fs.writeFile(targetPath(root), 'External edit after planning');
    await assert.rejects(applyPlan(plan), /changed.*refresh/i);
    assert.equal(await fs.readFile(targetPath(root), 'utf8'), 'External edit after planning');
  });
});

test('Swapping the store parent to a junction after planning cannot redirect writes', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writeConfiguration(checkpoint);
  await fs.writeFile(targetPath(root), 'Corrupted configuration');
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  const retained = path.join(root, 'retained-configuration');
  await fs.rename(path.join(root, '.vscode'), retained);
  await directoryLink(retained, path.join(root, '.vscode'));
  await assert.rejects(applyPlan(plan), /parent.*symbolic link|symbolic.*parent|scope changed/i);
  assert.equal(await fs.readFile(path.join(retained, 'agentscope.json'), 'utf8'), 'Corrupted configuration');
});

test('Replacing the ordinary workspace directory fails its captured identity guard', async t => {
  const { root, base } = await fixture(t);
  const plan = await buildPolicyRecoveryPlan(root, saved(root));
  await fs.rename(root, path.join(base, 'retained-workspace'));
  await fs.mkdir(root);
  await assert.rejects(applyPlan(plan), /directory.*changed|changed.*directory/i);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Recovery never follows a store-file symlink, including a broken link', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  const source = path.join(outside, 'agentscope.json');
  await fs.mkdir(path.dirname(targetPath(root)));
  await fs.writeFile(source, 'External configuration must be preserved');
  try { await fs.symlink(source, targetPath(root), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('The current OS account cannot create file symbolic links.'); return;
    }
    throw error;
  }
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction|regular file/);
  assert.equal(await fs.readFile(source, 'utf8'), 'External configuration must be preserved');
  await fs.unlink(source);
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
});
