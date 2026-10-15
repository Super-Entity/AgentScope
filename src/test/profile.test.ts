import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { generateProfile, updateCodexConfig } from '../core/profile';
import { ACCESS_POLICY_FILE, emptyRegistry } from '../core/registry';
import type { CodexFilesystemMode } from '../core/runtimePaths';
import { fixture, project, registry } from './helpers';

function parsedProfile(text: string): { filesystem: Record<string, string>; network: { enabled: boolean } } {
  const parsed = TOML.parse(text) as unknown as { permissions: { agentscope: { filesystem: Record<string, string>; network: { enabled: boolean } } } };
  return parsed.permissions.agentscope;
}

test('Generated permissions retain precise read/write paths and deny disabled projects', async (t) => {
  const { root } = await fixture(t);
  const value = registry({ disabled: project({ path: 'secret', enabled: false, restrict_paths: false }), all: project({ path: 'full', restrict_paths: false }) });
  const gitRead = path.join(root, 'project', '.git');
  const gitWrite = path.join(root, '.git', 'modules', 'project');
  const output = generateProfile(value, { root, filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: false, gitReadPaths: [gitRead], gitWritePaths: [gitWrite] });
  const parsed = parsedProfile(output.text);
  assert.equal(parsed.filesystem[':root'], 'deny');
  assert.equal(parsed.filesystem[':minimal'], 'read');
  assert.equal(parsed.filesystem[root], undefined);
  assert.equal(parsed.filesystem[path.join(root, 'project')], undefined);
  assert.equal(parsed.filesystem[path.join(root, 'project', 'references')], 'read');
  assert.equal(parsed.filesystem[path.join(root, 'project', 'drafts')], 'write');
  assert.equal(parsed.filesystem[path.join(root, 'secret')], 'deny');
  assert.equal(parsed.filesystem[path.join(root, 'full')], 'write');
  assert.equal(parsed.filesystem[path.join(root, 'Instructions')], 'read');
  assert.equal(parsed.filesystem[path.join(root, ACCESS_POLICY_FILE)], undefined);
  assert.equal(parsed.filesystem[path.join(root, 'AGENTS.md')], undefined);
  assert.equal(parsed.filesystem[path.join(root, '.agentscope')], undefined, 'Policy reads must not grant the whole tool folder');
  assert.equal(parsed.filesystem[gitRead], 'read');
  assert.equal(parsed.filesystem[gitWrite], 'write');
  assert.equal(parsed.network.enabled, false);
  assert.ok(output.warnings.length > 0);
  assert.equal(output.broadReadAccess, false);
});

test('An enabled restricted project with empty paths receives no project grant', async (t) => {
  const { root } = await fixture(t);
  const value = registry({ project: project({ read_paths: [], write_paths: [] }) });
  const output = parsedProfile(generateProfile(value, { root, filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: true }).text);
  assert.equal(output.filesystem[path.join(root, 'project')], undefined);
  assert.equal(Object.keys(output.filesystem).some(key => key.startsWith(path.join(root, 'project') + path.sep)), false);
  assert.equal(output.network.enabled, true);
});

test('Runtime path mapping translates every grant and deny while keeping the selected workspace anchor', async (t) => {
  const { root } = await fixture(t);
  const value = registry({ secret: project({ path: 'secret', enabled: false }) });
  const runtimeRoot = '/mnt/d/MyApps';
  const gitRead = path.join(root, 'project', '.git');
  const gitWrite = path.join(root, '.git', 'modules', 'project');
  const output = parsedProfile(generateProfile(value, {
    root, runtimeRoot, profileName: 'agentscope', allowNetwork: false,
    gitReadPaths: [gitRead], gitWritePaths: [gitWrite],
  }).text);
  assert.equal(output.filesystem['/mnt/d/MyApps/.agentscope/access.md'], undefined);
  assert.equal(output.filesystem['/mnt/d/MyApps/.codex'], 'read');
  assert.equal(output.filesystem['/mnt/d/MyApps/Instructions'], 'read');
  assert.equal(output.filesystem['/mnt/d/MyApps/project/references'], 'read');
  assert.equal(output.filesystem['/mnt/d/MyApps/project/drafts'], 'write');
  assert.equal(output.filesystem['/mnt/d/MyApps/secret'], 'deny');
  assert.equal(output.filesystem['/mnt/d/MyApps/project/.git'], 'read');
  assert.equal(output.filesystem['/mnt/d/MyApps/.git/modules/project'], 'write');
  assert.equal(output.filesystem[runtimeRoot], undefined, 'Mapping must not grant the workspace root');
  assert.equal(output.filesystem[':workspace_roots'], undefined, 'Choices must not repeat across unrelated workspace roots');
  assert.equal(Object.keys(output.filesystem).some(key => key.startsWith(root)), false);
});

test('Runtime path overrides never bypass local Git metadata containment checks', async (t) => {
  const { root, outside } = await fixture(t);
  assert.throws(() => generateProfile(registry(), {
    root, runtimeRoot: '/mnt/d/MyApps', profileName: 'agentscope', allowNetwork: false, gitWritePaths: [outside],
  }), /Git metadata/);
  for (const runtimeRoot of ['relative/workspace', '/mnt/d/../other', ':workspace_roots']) {
    assert.throws(() => generateProfile(registry(), { root, runtimeRoot, profileName: 'agentscope', allowNetwork: false }));
  }
});

test('An actual selected filesystem root remains a valid resolved runtime anchor', () => {
  const root = path.parse(process.cwd()).root;
  const output = parsedProfile(generateProfile(emptyRegistry(), {
    root, runtimeRoot: root, filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: false,
  }).text);
  assert.equal(output.filesystem[path.join(root, ACCESS_POLICY_FILE)], undefined);
  assert.equal(output.filesystem[root], undefined);
});

test('An ordinary repository profile grants selected subtrees without granting the whole root', async (t) => {
  const { root } = await fixture(t);
  const value = emptyRegistry();
  value.submodules.repository = project({ path: '.', read_paths: ['src'], write_paths: ['docs'], instruction_file: 'src/workflow.md' });
  const output = parsedProfile(generateProfile(value, { root, filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: false }).text);
  assert.equal(output.filesystem[root], undefined);
  assert.equal(output.filesystem[path.join(root, 'src')], 'read');
  assert.equal(output.filesystem[path.join(root, 'docs')], 'write');
});

test('Windows compatibility allows broad reads without adding writes or disabled-project denies', async (t) => {
  const { root } = await fixture(t);
  const value = registry({ disabled: project({ path: 'secret', enabled: false }), empty: project({ path: 'empty', read_paths: [], write_paths: [] }) });
  const gitWrite = path.join(root, '.git', 'modules', 'project');
  const output = generateProfile(value, {
    root, runtimeRoot: 'D:\\MyApps', profileName: 'agentscope', allowNetwork: false,
    gitReadPaths: [path.join(root, 'project', '.git')], gitWritePaths: [gitWrite],
  });
  const permissions = parsedProfile(output.text).filesystem;
  assert.equal(output.broadReadAccess, true);
  assert.equal(permissions[':root'], 'read');
  assert.equal(Object.values(permissions).includes('deny'), false);
  assert.deepEqual(Object.entries(permissions).filter(([, mode]) => mode === 'write').map(([target]) => target), [
    ':tmpdir', 'D:\\MyApps\\project\\drafts', 'D:\\MyApps\\.git\\modules\\project',
  ]);
  assert.equal(permissions['D:\\MyApps\\project\\references'], undefined, 'Redundant reads must not become Windows read-only carveouts');
  assert.equal(permissions['D:\\MyApps\\secret'], undefined);
  assert.equal(permissions['D:\\MyApps\\empty'], undefined);
  assert.equal(parsedProfile(output.text).network.enabled, false);
  assert.match(output.text, /# WARNING: .*all files, including disabled projects and unselected paths/);
  assert.ok(output.warnings.some(warning => /Read selections do not restrict OS-level reads/.test(warning)));
  assert.ok(output.warnings.some(warning => /unelevated sandbox/.test(warning)));
});

test('A redundant read parent does not obstruct its precise writable descendant on Windows', async (t) => {
  const { root } = await fixture(t);
  const value = registry({ project: project({ read_paths: ['src'], write_paths: ['src/generated'] }) });
  const output = generateProfile(value, { root, runtimeRoot: 'D:\\MyApps', profileName: 'agentscope', allowNetwork: false });
  const permissions = parsedProfile(output.text).filesystem;
  assert.equal(permissions['D:\\MyApps\\project\\src'], undefined);
  assert.equal(permissions['D:\\MyApps\\project\\src\\generated'], 'write');
  assert.equal(permissions['D:\\MyApps\\project'], undefined);
});

test('Windows compatibility preserves read-only carveouts inside an explicitly writable root', async (t) => {
  const { root } = await fixture(t);
  const value = emptyRegistry();
  value.submodules.repository = project({ path: '.', restrict_paths: false });
  const output = generateProfile(value, { root, runtimeRoot: 'D:\\MyApps', profileName: 'agentscope', allowNetwork: false });
  const permissions = parsedProfile(output.text).filesystem;
  assert.equal(permissions['D:\\MyApps'], 'write');
  assert.equal(permissions['D:\\MyApps\\AGENTS.md'], undefined);
  assert.equal(permissions['D:\\MyApps\\.agentscope\\access.md'], undefined);
  assert.equal(permissions['D:\\MyApps\\.codex'], 'read');
});

test('Windows compatibility refuses writable descendants of retained read-only carveouts', async (t) => {
  const { root } = await fixture(t);
  const value = emptyRegistry();
  value.submodules.repository = project({ path: '.', read_paths: [], write_paths: ['.', '.codex/cache'] });
  assert.throws(() => generateProfile(value, {
    root, runtimeRoot: 'D:\\MyApps', profileName: 'agentscope', allowNetwork: false,
  }), /read-only path .*\.codex.*writable descendant.*WSL2.*MXC.*not broadened/);
  const strict = generateProfile(value, {
    root, runtimeRoot: 'D:\\MyApps', filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: false,
  });
  assert.equal(parsedProfile(strict.text).filesystem['D:\\MyApps\\.codex\\cache'], 'write');
});

test('Strict Windows mode retains precise reads and warns that a compatible backend is required', async (t) => {
  const { root } = await fixture(t);
  const output = generateProfile(registry({ disabled: project({ path: 'secret', enabled: false }) }), {
    root, runtimeRoot: 'D:\\MyApps', filesystemMode: 'strict', profileName: 'agentscope', allowNetwork: false,
  });
  const permissions = parsedProfile(output.text).filesystem;
  assert.equal(output.broadReadAccess, false);
  assert.equal(permissions[':root'], 'deny');
  assert.equal(permissions['D:\\MyApps\\project\\references'], 'read');
  assert.equal(permissions['D:\\MyApps\\secret'], 'deny');
  assert.ok(output.warnings.some(warning => /MXC.*WSL2/.test(warning)));
  assert.equal((TOML.parse(output.text) as Record<string, unknown>).windows, undefined, 'Generating permissions must not select a sandbox backend');
});

test('A portable Windows-compatible preset retains strict reads when its runtime is POSIX', async (t) => {
  const { root } = await fixture(t);
  for (const filesystemMode of ['auto', 'windows-compatible'] as const) {
    const output = generateProfile(registry({ disabled: project({ path: 'secret', enabled: false }) }), {
      root, runtimeRoot: '/mnt/d/MyApps', filesystemMode, profileName: 'agentscope', allowNetwork: false,
    });
    const permissions = parsedProfile(output.text).filesystem;
    assert.equal(output.broadReadAccess, false);
    assert.equal(permissions[':root'], 'deny');
    assert.equal(permissions['/mnt/d/MyApps/project/references'], 'read');
    assert.equal(permissions['/mnt/d/MyApps/secret'], 'deny');
    assert.equal(output.warnings.some(warning => /OS-level reads of all files/.test(warning)), false);
  }
});

test('Invalid filesystem modes fail closed during profile generation', async (t) => {
  const { root } = await fixture(t);
  for (const filesystemMode of ['unknown', null, true]) {
    assert.throws(() => generateProfile(registry(), {
      root, filesystemMode: filesystemMode as CodexFilesystemMode, profileName: 'agentscope', allowNetwork: false,
    }), /filesystem mode/);
  }
});

test('Profile generation rejects invalid names and Git metadata outside the root', async (t) => {
  const { root, outside } = await fixture(t);
  assert.throws(() => generateProfile(registry(), { root, profileName: 'bad.name', allowNetwork: false }), /profile name/);
  assert.throws(() => generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false, gitWritePaths: [outside] }), /Git metadata/);
});

test('Updating TOML keeps unrelated tables, comments and multiline strings', async (t) => {
  const { root } = await fixture(t);
  const source = '# existing header\r\nmodel = "my-model" # keep model comment\r\nnotes = """\r\n[not_a_table]\r\ndefault_permissions = "do not edit this string"\r\n"""\r\n[tools]\r\nweb = true # preserve\r\n';
  const generated = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const updated = updateCodexConfig(source, generated, 'agentscope');
  assert.ok(updated.includes(source));
  const parsed = TOML.parse(updated);
  assert.equal(parsed.default_permissions, 'agentscope');
  assert.equal(parsed.model, 'my-model');
  assert.match(String(parsed.notes), /default_permissions = "do not edit this string"/);
  assert.equal(updateCodexConfig(updated, generated, 'agentscope'), updated);
});

test('Managed TOML replacement updates the profile without duplicating existing content', async (t) => {
  const { root } = await fixture(t);
  const first = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const second = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: true }).text;
  const updated = updateCodexConfig('default_permissions = "old" # keep choice comment\n[features]\nuseful = true\n', first, 'agentscope');
  const replaced = updateCodexConfig(updated, second, 'agentscope');
  assert.equal((replaced.match(/BEGIN AgentScope managed profile/g) || []).length, 1);
  assert.match(replaced, /# keep choice comment/);
  assert.equal(parsedProfile(replaced).network.enabled, true);
  assert.deepEqual(TOML.parse(replaced).features, { useful: true });
});

test('Managed TOML replacement preserves the semantic owner of trailing user assignments', async (t) => {
  const { root } = await fixture(t);
  const first = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const second = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: true }).text;
  const base = updateCodexConfig('[tools]\nweb = true\n', first, 'agentscope');
  const source = base + '# user assignment remains outside the managed markers\nquota = 5\n' +
    'notes = """\n[not_a_table]\n# BEGIN AgentScope managed profile: agentscope\n"""\n' +
    '[other]\nlocal = 1979-05-27T07:32:00Z\n';
  const before = TOML.parse(source) as any;
  const replaced = updateCodexConfig(source, second, 'agentscope');
  const after = TOML.parse(replaced) as any;
  assert.equal(before.permissions.agentscope.network.quota, 5);
  assert.equal(after.permissions.agentscope.network.quota, 5);
  assert.equal(after.permissions.agentscope.network.notes, before.permissions.agentscope.network.notes);
  assert.equal(after.tools.quota, undefined);
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.other, before.other);
  assert.equal(after.permissions.agentscope.network.enabled, true);
  assert.ok(replaced.includes(source.slice(base.length)));
});

test('A profile with a different final table cannot silently move a trailing user key', async (t) => {
  const { root } = await fixture(t);
  const profile = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const source = updateCodexConfig('[tools]\nweb = true\n', profile, 'agentscope') + 'quota = 5\n';
  const reversed = '[permissions.agentscope.network]\nenabled = true\n' +
    '[permissions.agentscope.filesystem]\n":root" = "deny"\n';
  assert.throws(() => updateCodexConfig(source, reversed, 'agentscope'), /unrelated TOML|table owning/);
});

test('In-place managed replacement retains CRLF and other profiles before and after its block', async (t) => {
  const { root } = await fixture(t);
  const first = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const second = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: true }).text;
  const firstConfig = updateCodexConfig('# retained\r\n[permissions.personal.network]\r\nenabled = false\r\n', first, 'agentscope');
  const source = firstConfig + '# trailing table\r\n[tools]\r\nweb = true\r\n';
  const before = TOML.parse(source) as any;
  const afterText = updateCodexConfig(source, second, 'agentscope');
  const after = TOML.parse(afterText) as any;
  assert.deepEqual(after.permissions.personal, before.permissions.personal);
  assert.deepEqual(after.tools, before.tools);
  assert.ok(afterText.endsWith('# trailing table\r\n[tools]\r\nweb = true\r\n'));
  assert.ok(!/(?<!\r)\n/.test(afterText));
});

test('Legacy sandbox conflicts and user-owned profiles are refused without overwriting', async (t) => {
  const { root } = await fixture(t);
  const generated = generateProfile(registry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  for (const source of ['sandbox_mode = "workspace-write"\n', '[sandbox_workspace_write]\nnetwork_access = false\n', '"sandbox_mode" = "read-only"\n']) {
    assert.throws(() => updateCodexConfig(source, generated, 'agentscope'), /legacy sandbox settings/);
  }
  assert.throws(() => updateCodexConfig('[permissions.agentscope.filesystem]\n":root" = "read"\n', generated, 'agentscope'), /user-owned/);
  assert.throws(() => updateCodexConfig('invalid = [\n', generated, 'agentscope'), /invalid TOML/);
});
