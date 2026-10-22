import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from '../configuration';
import { writePreset } from '../presets';
import { applyPlan } from '../transactions';
import { ApplyOptions, buildApplyPlan, loadWorkspace, loadWorkspaceForReconfiguration } from '../workspace';
import { assertWorkspaceLocation, WorkspaceLocationError } from '../workspaceLocation';
import { fixture, project, registry } from './helpers';

const options: ApplyOptions = {
  generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true,
  allowNetwork: false, codexRuntime: 'native', codexFilesystemMode: 'strict', codexWindowsSandbox: 'legacy',
};

test('An existing workspace passes the location check without creating files', async t => {
  const { root } = await fixture(t);
  await assertWorkspaceLocation(root);
  assert.deepEqual(await fs.readdir(root), []);
});

test('A relocated workspace produces an actionable location error from loading and planning', async t => {
  const { base, root } = await fixture(t);
  const loaded = await loadWorkspace(root);
  const relocated = path.join(base, 'relocated-workspace');
  await fs.rename(root, relocated);
  const moved = (error: unknown): boolean => {
    assert.ok(error instanceof WorkspaceLocationError);
    assert.equal(error.root, root);
    assert.equal(error.reason, 'missing');
    assert.ok(error.message.includes(root));
    assert.match(error.message, /Reopen the folder at its current location in VS Code/);
    assert.match(error.message, /start a new Codex chat/);
    assert.match(error.message, /Existing chats keep their original working directory/);
    assert.match(error.message, /WSL.*Linux workspace path/);
    return true;
  };
  await assert.rejects(assertWorkspaceLocation(root), moved);
  await assert.rejects(loadWorkspace(root), moved);
  await assert.rejects(loadWorkspaceForReconfiguration(root), moved);
  await assert.rejects(buildApplyPlan(loaded, options), moved);
  assert.deepEqual(await fs.readdir(relocated), []);
});

test('A file at the selected workspace path cannot be treated as damaged configuration', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'ordinary-file');
  await fs.writeFile(file, 'Keep this file.');
  await assert.rejects(loadWorkspace(file), error => {
    assert.ok(error instanceof WorkspaceLocationError);
    assert.equal(error.root, file);
    assert.equal(error.reason, 'not-directory');
    return true;
  });
  await assert.rejects(assertWorkspaceLocation(path.join(file, 'child')), WorkspaceLocationError);
  assert.equal(await fs.readFile(file, 'utf8'), 'Keep this file.');
});

test('Permission and link-resolution failures retain their original errors', async t => {
  const { root } = await fixture(t);
  for (const code of ['EACCES', 'EPERM', 'ELOOP']) {
    const failure = Object.assign(new Error(`Original ${code} failure`), { code });
    const mocked = t.mock.method(fs, 'stat', async () => { throw failure; });
    await assert.rejects(assertWorkspaceLocation(root), error => error === failure);
    mocked.mock.restore();
  }
});

test('Reapplying a moved workspace regenerates every profile path while preserving relative preset choices', async t => {
  const { base, root } = await fixture(t);
  const value = registry({ disabled: project({ path: 'disabled', enabled: false }) });
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, SCOPE_CONFIGURATION_FILE), writeScopeConfiguration(null, value));
  await writePreset(root, 'Writing', { registry: value, hidden: {}, resourceHidden: {}, options });
  await applyPlan(await buildApplyPlan(await loadWorkspace(root), options));
  const presets = await fs.readFile(path.join(root, '.vscode/agentscope-presets.json'), 'utf8');
  const configuration = await fs.readFile(path.join(root, SCOPE_CONFIGURATION_FILE), 'utf8');
  const relocated = path.join(base, 'relocated-workspace');
  await fs.rename(root, relocated);

  const loaded = await loadWorkspace(relocated);
  assert.deepEqual(loaded.registry, value);
  const plan = await buildApplyPlan(loaded, options);
  assert.deepEqual(plan.changes.map(change => path.relative(relocated, change.path)), [path.join('.codex', 'config.toml')]);
  await applyPlan(plan);
  const config = TOML.parse(await fs.readFile(path.join(relocated, '.codex/config.toml'), 'utf8')) as Record<string, any>;
  for (const name of ['agentscope', 'Writing - AgentScope']) {
    const filesystem = config.permissions[name].filesystem;
    assert.equal(filesystem[path.join(relocated, 'project/drafts')], 'write');
    assert.equal(filesystem[path.join(relocated, 'project/references')], 'read');
    assert.equal(filesystem[path.join(relocated, 'disabled')], 'deny');
    assert.ok(!Object.keys(filesystem).some(target => target === root || target.startsWith(root + path.sep)));
  }
  assert.equal(await fs.readFile(path.join(relocated, '.vscode/agentscope-presets.json'), 'utf8'), presets);
  assert.equal(await fs.readFile(path.join(relocated, SCOPE_CONFIGURATION_FILE), 'utf8'), configuration);
  assert.deepEqual((await buildApplyPlan(await loadWorkspace(relocated), options)).changes, []);
});
