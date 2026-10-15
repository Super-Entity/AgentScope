import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { SCOPE_CONFIGURATION_FILE, readScopeConfiguration, writeScopeConfiguration } from '../configuration';
import { writeAccessFiles } from '../core/registry';
import { writePreset } from '../presets';
import { applyPlan } from '../transactions';
import { ApplyOptions, buildApplyPlan, loadWorkspace } from '../workspace';
import { WindowsSandboxDetection } from '../windowsSandbox';
import { fixture, project, registry } from './helpers';

const options: ApplyOptions = { generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false, codexFilesystemMode: 'auto', codexRuntime: 'native' };
const supported: WindowsSandboxDetection = { mxcAvailable: true, eligible: true, probed: true, code: 'mxc-verified', reason: 'Verified by test probe.' };
const unsupported: WindowsSandboxDetection = { mxcAvailable: false, eligible: true, probed: true, code: 'probe-failed', reason: 'Capability missing.' };
function parsed(plan: Awaited<ReturnType<typeof buildApplyPlan>>): any {
  return TOML.parse(plan.changes.find(change => change.path.endsWith('config.toml'))!.after);
}
async function initialize(root: string) {
  await fs.mkdir(path.join(root, '.vscode'));
  const value = registry({ second: project({ path: 'second', enabled: false }) });
  await fs.writeFile(path.join(root, SCOPE_CONFIGURATION_FILE), writeScopeConfiguration(null, value));
  return value;
}

test('First Apply creates editor state and runtime config without creating instruction or access files', async t => {
  const { root } = await fixture(t);
  await applyPlan(await buildApplyPlan(await loadWorkspace(root), options));
  assert.ok(readScopeConfiguration(await fs.readFile(path.join(root, SCOPE_CONFIGURATION_FILE), 'utf8')));
  await assert.rejects(fs.stat(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.agentscope')), { code: 'ENOENT' });
  assert.deepEqual((await buildApplyPlan(await loadWorkspace(root), options)).changes, []);
});

test('Exporting an older preset cannot reopen a newly registered disabled project as a workspace resource', async t => {
  const { root } = await fixture(t);
  const value = await initialize(root);
  const older = structuredClone(value);
  delete older.submodules.second;
  older.shared_resources.write_paths = ['second'];
  await writePreset(root, 'Older registration', { registry: older, hidden: {}, resourceHidden: {}, options });
  await assert.rejects(buildApplyPlan(await loadWorkspace(root), options), /Shared resource overlaps a registered project/);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('Legacy migration detaches generated instructions and no longer reads a sidecar after Apply', async t => {
  const { root } = await fixture(t);
  const legacy = writeAccessFiles('# Personal rules\nKeep this exactly.\n', null, registry());
  await fs.mkdir(path.join(root, '.agentscope'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), legacy.agents);
  await fs.writeFile(path.join(root, '.agentscope/access.md'), legacy.access);
  const plan = await buildApplyPlan(await loadWorkspace(root), options);
  assert.ok(!plan.changes.some(change => change.path.endsWith('access.md')));
  await applyPlan(plan);
  const main = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(main, /# Personal rules\nKeep this exactly\.\n/);
  assert.doesNotMatch(main, /AgentScope access reference/);
  assert.equal(await fs.readFile(path.join(root, '.agentscope/access.md'), 'utf8'), legacy.access);
  await fs.writeFile(path.join(root, '.agentscope/access.md'), 'Invalid old sidecar');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'User instructions without any scope registry');
  assert.deepEqual((await loadWorkspace(root)).registry, registry());
  assert.deepEqual((await buildApplyPlan(await loadWorkspace(root), options)).changes, []);
});

test('Saved presets use readable independent profiles and update only the selected preset definition', async t => {
  const { root } = await fixture(t);
  const options: ApplyOptions = { generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false, codexFilesystemMode: 'strict' };
  const first = await initialize(root);
  const second = structuredClone(first);
  second.submodules.project.enabled = false; second.submodules.second.enabled = true;
  await writePreset(root, 'First', { registry: first, hidden: {}, resourceHidden: {}, options });
  await writePreset(root, 'Second', { registry: second, hidden: {}, resourceHidden: {}, options });
  const plan = await buildApplyPlan(await loadWorkspace(root), options);
  assert.equal(plan.exportedProfiles?.length, 2);
  const config = parsed(plan);
  assert.equal(config.default_permissions, 'agentscope');
  const [a, b] = plan.exportedProfiles!;
  assert.notEqual(a.profileName, b.profileName);
  assert.equal(a.profileName, 'First - AgentScope');
  assert.equal(b.profileName, 'Second - AgentScope');
  const firstFs = config.permissions[a.profileName].filesystem;
  const secondFs = config.permissions[b.profileName].filesystem;
  const target = (relative: string) => path.join(root, relative);
  assert.equal(firstFs[target('project/drafts')], 'write');
  assert.equal(firstFs[target('second')], 'deny');
  assert.equal(secondFs[target('second/drafts')], 'write');
  assert.equal(secondFs[target('project')], 'deny');
  assert.equal(firstFs[target('AGENTS.md')], undefined);
  assert.equal(firstFs[target('.agentscope/access.md')], undefined);
  await applyPlan(plan);
  const edited = structuredClone(first); edited.submodules.project.write_paths = [];
  await writePreset(root, 'First', { registry: edited, hidden: {}, resourceHidden: {}, options });
  const updated = await buildApplyPlan(await loadWorkspace(root), options);
  const latest = updated.exportedProfiles!.find(profile => profile.presetName === 'First')!;
  assert.equal(latest.profileName, a.profileName);
  assert.deepEqual(parsed(updated).permissions[b.profileName], config.permissions[b.profileName], 'Updating First leaves the independent Second preset unchanged');
  assert.equal(parsed(updated).permissions[latest.profileName].filesystem[target('project/drafts')], undefined);
  assert.ok(updated.warnings.some(warning => /Updating this named profile/.test(warning)));
});

test('Verified MXC pins its backend and Auto generates strict native Windows profiles for every preset', async t => {
  const { root } = await fixture(t);
  const value = await initialize(root);
  const native = { ...options, codexWorkspaceRoot: 'Z:\\Apps' };
  await writePreset(root, 'Native', { registry: value, hidden: {}, resourceHidden: {}, options: native });
  let probes = 0;
  const plan = await buildApplyPlan(await loadWorkspace(root), native, { detectWindowsSandbox: async () => { probes++; return supported; } });
  assert.equal(probes, 1);
  assert.equal(plan.broadReadAccess, false);
  const config = parsed(plan);
  assert.equal(config.windows.sandbox, 'mxc');
  assert.equal(config.permissions.agentscope.filesystem[':root'], 'deny');
  assert.equal(config.permissions[plan.exportedProfiles![0].profileName].filesystem[':root'], 'deny');
});

test('Failed MXC verification falls back visibly; explicitly required MXC refuses to produce a plan', async t => {
  const { root } = await fixture(t);
  await initialize(root);
  const native = { ...options, codexWorkspaceRoot: 'Z:\\Apps' };
  const dependencies = { detectWindowsSandbox: async () => unsupported };
  const plan = await buildApplyPlan(await loadWorkspace(root), native, dependencies);
  assert.equal(plan.broadReadAccess, true);
  assert.equal(parsed(plan).windows.sandbox, 'elevated');
  assert.equal(parsed(plan).permissions.agentscope.filesystem[':root'], 'read');
  assert.ok(plan.warnings.includes('Capability missing.'));
  await assert.rejects(buildApplyPlan(await loadWorkspace(root), { ...native, codexWindowsSandbox: 'mxc' }, dependencies), /MXC is required/);
  await assert.rejects(fs.stat(path.join(root, '.codex')), { code: 'ENOENT' });
});

test('WSL Auto presets use POSIX grants and never probe or configure Windows MXC', async t => {
  const { root } = await fixture(t);
  const value = await initialize(root);
  await writePreset(root, 'Auto runtime', { registry: value, hidden: {}, resourceHidden: {}, options: { ...options, codexRuntime: 'auto' } });
  // A custom mapping belongs to this workspace; all presets using auto inherit the host preference.
  const plan = await buildApplyPlan(await loadWorkspace(root), { ...options, codexRuntime: 'wsl', codexAutoRuntime: 'wsl', codexWorkspaceRoot: '/mnt/z/Apps' }, {
    detectWindowsSandbox: async () => { throw new Error('WSL must not probe Windows'); },
  });
  const config = parsed(plan);
  assert.equal(config.windows, undefined);
  assert.equal(config.permissions.agentscope.filesystem[':root'], 'deny');
  const savedFs = config.permissions[plan.exportedProfiles![0].profileName].filesystem;
  assert.equal(savedFs[':root'], 'deny');
  assert.ok(!Object.keys(savedFs).some(key => /^[A-Za-z]:/.test(key)));
});

test('Older presets inherit configured defaults independently of the active preset options', async t => {
  const { root } = await fixture(t);
  const value = await initialize(root);
  const olderOptions: ApplyOptions = {
    generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: true, allowNetwork: false,
  };
  await writePreset(root, 'Older preset', { registry: value, hidden: {}, resourceHidden: {}, options: olderOptions });
  const configuredDefaults: ApplyOptions = { ...options, codexWorkspaceRoot: 'Z:\\Apps', codexFilesystemMode: 'auto' };
  const activeOptions: ApplyOptions = { ...configuredDefaults, codexFilesystemMode: 'strict' };
  const plan = await buildApplyPlan(await loadWorkspace(root), activeOptions, {
    presetDefaults: configuredDefaults, detectWindowsSandbox: async () => unsupported,
  });
  const config = parsed(plan);
  assert.equal(config.permissions.agentscope.filesystem[':root'], 'deny');
  const older = plan.exportedProfiles!.find(profile => profile.presetName === 'Older preset')!;
  assert.equal(config.permissions[older.profileName].filesystem[':root'], 'read');
  assert.equal(older.broadReadAccess, true);
  assert.equal(config.windows.sandbox, 'elevated');
});
