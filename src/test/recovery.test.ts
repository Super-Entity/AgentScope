import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { ACCESS_POLICY_FILE, readAccessRegistry, writeAccessFiles } from '../core/registry';
import {
  buildPolicyRecoveryPlan, checkpointFromLastApply, checkpointKey, createCheckpoint, PolicyCheckpoint, validateCheckpoint,
} from '../recovery';
import { applyPlan, restoreChanges } from '../transactions';
import { FileChange, WorkspaceState } from '../types';
import { directoryLink, fixture, registry } from './helpers';

function saved(root: string, prose = '# My project rules\n\nKeep these instructions.\n'): PolicyCheckpoint {
  const files = writeAccessFiles(prose, null, registry());
  return { version: 1, root, agents: files.agents, access: files.access, savedAt: '2026-01-02T03:04:05.000Z' };
}

function state(checkpoint: PolicyCheckpoint): WorkspaceState {
  return {
    root: checkpoint.root, registry: readAccessRegistry(checkpoint.agents, checkpoint.access)!,
    hidden: {}, dirty: false, warnings: [],
    files: {
      [path.join(checkpoint.root, 'AGENTS.md')]: checkpoint.agents,
      [path.join(checkpoint.root, ...ACCESS_POLICY_FILE.split('/'))]: checkpoint.access,
    },
  };
}

async function writePair(checkpoint: PolicyCheckpoint): Promise<void> {
  await fs.mkdir(path.join(checkpoint.root, '.agentscope'), { recursive: true });
  await fs.writeFile(path.join(checkpoint.root, 'AGENTS.md'), checkpoint.agents);
  await fs.writeFile(path.join(checkpoint.root, '.agentscope', 'access.md'), checkpoint.access);
}

function outputs(checkpoint: PolicyCheckpoint): FileChange[] {
  return [
    { path: path.join(checkpoint.root, '.agentscope', 'access.md'), before: null, after: checkpoint.access },
    { path: path.join(checkpoint.root, 'AGENTS.md'), before: '# Existing instructions\n', after: checkpoint.agents },
    { path: path.join(checkpoint.root, '.vscode', 'settings.json'), before: null, after: '{}' },
    { path: path.join(checkpoint.root, '.codex', 'config.toml'), before: null, after: '# Generated profile\n' },
  ];
}

test('A checkpoint captures the complete linked policy and all user prose without mutating the workspace state', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root, '\uFEFF# My rules\r\n\r\nCustom instructions stay.\r\n');
  const workspace = state(checkpoint);
  const original = JSON.stringify(workspace);
  const captured = createCheckpoint(workspace);
  assert.ok(captured);
  assert.equal(captured.root, root);
  assert.equal(captured.agents, checkpoint.agents);
  assert.equal(captured.access, checkpoint.access);
  assert.equal(new Date(captured.savedAt).toISOString(), captured.savedAt);
  assert.equal(JSON.stringify(workspace), original);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Partial, draft, malformed and conflicting policy pairs never produce a replacement checkpoint', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  const candidates: WorkspaceState[] = [
    { ...state(checkpoint), dirty: true },
    { ...state(checkpoint), files: undefined },
    { ...state(checkpoint), files: {} },
  ];
  for (const target of ['AGENTS.md', '.agentscope/access.md']) {
    const missing = state(checkpoint);
    missing.files![path.join(root, ...target.split('/'))] = null;
    candidates.push(missing);
    const corrupted = state(checkpoint);
    corrupted.files![path.join(root, ...target.split('/'))] = 'Invalid policy without managed instructions';
    candidates.push(corrupted);
  }
  const conflict = state(checkpoint);
  conflict.files![path.join(root, 'AGENTS.md')] = '# Old policy\n```json\n'
    + JSON.stringify(registry()) + '\n```\n';
  candidates.push(conflict);
  for (const candidate of candidates) assert.equal(createCheckpoint(candidate), null);
});

test('Policy checkpoint validation rejects unknown formats, roots, timestamps and unsafe grants', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  const invalid: unknown[] = [
    null, [], 'snapshot', {},
    { ...checkpoint, version: 2 },
    { ...checkpoint, extra: 'unrecognized' },
    { ...checkpoint, root: outside },
    { ...checkpoint, root: 'workspace' },
    { ...checkpoint, root: path.join(root, '..', 'workspace') + path.sep },
    { ...checkpoint, savedAt: 'invalid time' },
    { ...checkpoint, savedAt: '2026-01-02T03:04:05Z' },
    { ...checkpoint, agents: '' },
    { ...checkpoint, access: '' },
    { ...checkpoint, agents: checkpoint.agents.replace('Before reading', 'Custom extra policy. Before reading') },
    { ...checkpoint, access: checkpoint.access.replace('"references"', '"../outside"') },
    { ...checkpoint, access: checkpoint.access.replace('"enabled": true', '"enabled": true, "enabled": false') },
  ];
  for (const value of invalid) assert.throws(() => validateCheckpoint(value, root));
  assert.throws(() => validateCheckpoint(checkpoint, 'relative workspace'), /absolute normalized/);
  assert.deepEqual(validateCheckpoint(checkpoint, root), checkpoint);
});

test('Workspace checkpoint keys are stable, isolated and do not expose the workspace path', async t => {
  const { root, outside } = await fixture(t);
  const key = checkpointKey(root);
  assert.match(key, /^agentscope\.policyCheckpoint\.v1\.[a-f0-9]{64}$/);
  assert.equal(checkpointKey(root), key);
  assert.notEqual(checkpointKey(outside), key);
  assert.equal(key.includes(root), false);
  if (process.platform === 'win32') assert.equal(checkpointKey(root.toUpperCase()), key);
  assert.throws(() => checkpointKey('relative workspace'), /absolute normalized/);
});

test('A complete successful Apply backup can bootstrap a checkpoint without reading current files', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  const captured = checkpointFromLastApply(root, outputs(checkpoint));
  assert.ok(captured);
  assert.equal(captured.agents, checkpoint.agents);
  assert.equal(captured.access, checkpoint.access);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Partial or malformed Apply backups cannot infer or import a checkpoint', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  const changes = outputs(checkpoint);
  const invalid: unknown[] = [
    null, {}, [], changes.slice(0, 1), changes.slice(1),
    [...changes, changes[0]],
    [...changes, { path: path.join(root, 'unrelated.txt'), before: null, after: 'secret' }],
    [{ ...changes[0], path: path.join(outside, 'access.md') }, ...changes.slice(1)],
    [{ ...changes[0], before: undefined }, ...changes.slice(1)],
    [{ ...changes[0], after: null }, ...changes.slice(1)],
    [{ ...changes[0], extra: true }, ...changes.slice(1)],
    [{ ...changes[0], path: '.agentscope/access.md' }, ...changes.slice(1)],
    [{ ...changes[0], after: 'Corrupt output' }, ...changes.slice(1)],
    [{ ...changes[0] }, { ...changes[1], after: '# Main instructions with no reference' }],
  ];
  for (const value of invalid) assert.equal(checkpointFromLastApply(root, value), null);
});

test('Recovery recreates both deleted files from exact saved contents and can undo their creation', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root, '# Preserve my rules\n\nA custom instruction.\n');
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(plan.changes.map(change => path.relative(root, change.path).replace(/\\/g, '/')),
    ['.agentscope/access.md', 'AGENTS.md']);
  assert.ok(plan.changes.every(change => change.before === null));
  assert.deepEqual(await fs.readdir(root), []);
  const changes = await applyPlan(plan);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), checkpoint.agents);
  assert.equal(await fs.readFile(path.join(root, '.agentscope', 'access.md'), 'utf8'), checkpoint.access);
  await restoreChanges(changes);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.agentscope', 'access.md')), { code: 'ENOENT' });
});

test('Recovery restores either deleted file while guarding the unchanged authoritative counterpart', async t => {
  for (const relative of ['AGENTS.md', '.agentscope/access.md']) {
    await t.test(relative, async child => {
      const { root } = await fixture(child);
      const checkpoint = saved(root);
      await writePair(checkpoint);
      const target = path.join(root, ...relative.split('/'));
      await fs.unlink(target);
      const plan = await buildPolicyRecoveryPlan(root, checkpoint);
      assert.equal(plan.changes.length, 1);
      assert.equal(plan.changes[0].path, target);
      assert.equal(plan.checks?.length, 2);
      await applyPlan(plan);
      assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), checkpoint.agents);
      assert.equal(await fs.readFile(path.join(root, '.agentscope', 'access.md'), 'utf8'), checkpoint.access);
    });
  }
});

test('Corrupted or conflicting contents are restored exactly and remain available in the undo transaction', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await fs.mkdir(path.join(root, '.agentscope'));
  const agents = '# Current user text\n\n```json\n' + JSON.stringify(registry()) + '\n```\n';
  const access = '<!-- BEGIN AgentScope access policy -->\nBroken JSON and lost end marker\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), agents);
  await fs.writeFile(path.join(root, '.agentscope', 'access.md'), access);
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.equal(plan.changes.find(change => path.basename(change.path) === 'AGENTS.md')?.before, agents);
  assert.equal(plan.changes.find(change => path.basename(change.path) === 'access.md')?.before, access);
  const changes = await applyPlan(plan);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), checkpoint.agents);
  await restoreChanges(changes);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(await fs.readFile(path.join(root, '.agentscope', 'access.md'), 'utf8'), access);
});

test('A healthy pair needs no writes and still has input and containment guards', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writePair(checkpoint);
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.checks?.length, 2);
  assert.equal(plan.pathChecks?.length, 4);
  await applyPlan(plan);
});

test('Recovery refuses a saved checkpoint from another workspace before reading configuration', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(outside);
  let reads = 0;
  t.mock.method(fs, 'readFile', async () => { reads++; throw new Error('Unexpected read'); });
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /different workspace/);
  assert.equal(reads, 0);
});

test('Recovery reads only the two exact policy files and ignores unrelated corrupt configuration', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writePair(checkpoint);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{ broken settings');
  await fs.writeFile(path.join(root, '.codex', 'config.toml'), '[broken profile');
  await fs.writeFile(path.join(root, '.gitmodules'), '[broken manifest');
  const realRead = fs.readFile.bind(fs);
  const reads: string[] = [];
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    reads.push(String(args[0]));
    return realRead(...args);
  });
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  assert.deepEqual(reads.sort(), [path.join(root, 'AGENTS.md'), path.join(root, '.agentscope', 'access.md')].sort());
  assert.deepEqual(plan.changes, []);
});

test('Recovery rejects linked policy directories even when their destination is inside the workspace', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  await directoryLink(outside, path.join(root, '.agentscope'));
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, '.agentscope'));
  const internal = path.join(root, 'retained-policy');
  await fs.mkdir(internal);
  await directoryLink(internal, path.join(root, '.agentscope'));
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
  assert.deepEqual(await fs.readdir(internal), []);
});

test('Policy directories and non-directory parents cannot become recovery targets', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await fs.mkdir(path.join(root, 'AGENTS.md'));
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /regular file/);
  await fs.rmdir(path.join(root, 'AGENTS.md'));
  await fs.writeFile(path.join(root, '.agentscope'), 'Keep this unrelated file');
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /directory|ENOTDIR/);
  assert.equal(await fs.readFile(path.join(root, '.agentscope'), 'utf8'), 'Keep this unrelated file');
});

test('A canonical workspace root cannot silently change into a junction', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  await fs.rmdir(root);
  await directoryLink(outside, root);
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /workspace root changed/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('External creation of either missing policy file after planning aborts the complete recovery', async t => {
  for (const relative of ['AGENTS.md', '.agentscope/access.md']) {
    await t.test(relative, async child => {
      const { root } = await fixture(child);
      const checkpoint = saved(root);
      const plan = await buildPolicyRecoveryPlan(root, checkpoint);
      const target = path.join(root, ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, 'An external edit after planning');
      await assert.rejects(applyPlan(plan), /changed.*refresh/i);
      assert.equal(await fs.readFile(target, 'utf8'), 'An external edit after planning');
      const other = relative === 'AGENTS.md' ? path.join(root, '.agentscope', 'access.md') : path.join(root, 'AGENTS.md');
      await assert.rejects(fs.stat(other), { code: 'ENOENT' });
    });
  }
});

test('A valid grant change in the unchanged counterpart invalidates the recovery plan', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writePair(checkpoint);
  await fs.unlink(path.join(root, 'AGENTS.md'));
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  const changed = checkpoint.access.replace('"enabled": true', '"enabled": false');
  await fs.writeFile(path.join(root, '.agentscope', 'access.md'), changed);
  await assert.rejects(applyPlan(plan), /changed.*refresh/i);
  assert.equal(await fs.readFile(path.join(root, '.agentscope', 'access.md'), 'utf8'), changed);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('Swapping a policy parent to a junction after planning cannot redirect writes', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await writePair(checkpoint);
  await fs.unlink(path.join(root, 'AGENTS.md'));
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  const retained = path.join(root, 'retained-policy');
  await fs.rename(path.join(root, '.agentscope'), retained);
  await directoryLink(retained, path.join(root, '.agentscope'));
  await assert.rejects(applyPlan(plan), /parent.*symbolic link|symbolic.*parent|scope changed/i);
  assert.equal(await fs.readFile(path.join(retained, 'access.md'), 'utf8'), checkpoint.access);
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('Failure of the second policy write rolls back the first to its complete pre-recovery contents', async t => {
  const { root } = await fixture(t);
  const checkpoint = saved(root);
  await fs.mkdir(path.join(root, '.agentscope'));
  const agentsPath = path.join(root, 'AGENTS.md');
  const accessPath = path.join(root, '.agentscope', 'access.md');
  await fs.writeFile(agentsPath, 'Corrupted main with user prose');
  await fs.writeFile(accessPath, 'Corrupted access with comments');
  const plan = await buildPolicyRecoveryPlan(root, checkpoint);
  const realRename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination) === agentsPath && !failed) {
      failed = true;
      throw new Error('Injected main policy replacement failure');
    }
    await realRename(source, destination);
  });
  await assert.rejects(applyPlan(plan), /Injected main policy/);
  assert.equal(await fs.readFile(agentsPath, 'utf8'), 'Corrupted main with user prose');
  assert.equal(await fs.readFile(accessPath, 'utf8'), 'Corrupted access with comments');
  assert.deepEqual((await fs.readdir(root)).sort(), ['.agentscope', 'AGENTS.md']);
  assert.deepEqual(await fs.readdir(path.join(root, '.agentscope')), ['access.md']);
});

test('Recovery never follows a policy-file symlink, including a broken link', async t => {
  const { root, outside } = await fixture(t);
  const checkpoint = saved(root);
  const source = path.join(outside, 'policy.md');
  await fs.writeFile(source, 'External policy must be preserved');
  const target = path.join(root, 'AGENTS.md');
  try { await fs.symlink(source, target, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('The current OS account cannot create file symbolic links.');
      return;
    }
    throw error;
  }
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction|regular file/);
  assert.equal(await fs.readFile(source, 'utf8'), 'External policy must be preserved');
  await fs.unlink(source);
  await assert.rejects(buildPolicyRecoveryPlan(root, checkpoint), /symbolic link|junction/);
});
