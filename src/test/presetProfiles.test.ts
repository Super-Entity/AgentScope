import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { exportPresetProfiles, presetProfileName, PresetProfileInput } from '../core/presetProfiles';
import { generateProfile, updateCodexConfig } from '../core/profile';
import { emptyRegistry } from '../core/registry';
import { fixture, project } from './helpers';

function input(root: string, name: string, selected: string): PresetProfileInput {
  const registry = emptyRegistry();
  registry.submodules.first = project({ path: 'first', enabled: selected === 'first', restrict_paths: false });
  registry.submodules.second = project({ path: 'second', enabled: selected === 'second', restrict_paths: false });
  return { name, registry, options: { root, filesystemMode: 'strict', allowNetwork: false } };
}

function parsed(text: string): {
  default_permissions?: string;
  permissions: Record<string, { description?: string; filesystem: Record<string, string>; network: { enabled: boolean } }>;
} { return TOML.parse(text) as unknown as ReturnType<typeof parsed>; }

function legacyName(name: string, revision = '0123456789ab'): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'preset';
  return `agentscope-preset-${slug}-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)}-${revision}`;
}

function legacyConfig(preset: PresetProfileInput, revision = '0123456789ab', selectDefault = true): string {
  const name = legacyName(preset.name, revision);
  const profile = generateProfile(preset.registry, { ...preset.options, profileName: name, description: `AgentScope: ${preset.name} (${revision.slice(0, 6)})` });
  return updateCodexConfig('', profile.text, name, selectDefault);
}

test('Preset IDs show the exact label and stay distinct across punctuation and non-Latin labels', () => {
  const names = ['My project', 'my-project', 'My  project', 'پروژه اول', 'پروژه دوم', 'é', 'e'];
  const ids = names.map(name => presetProfileName(name));
  assert.equal(new Set(ids).size, names.length);
  for (let index = 0; index < names.length; index++) {
    assert.equal(presetProfileName(names[index]), ids[index]);
    assert.equal(ids[index], `${names[index]} - AgentScope`);
  }
  for (const invalid of ['', ' outer ', 'a\nb', 'x'.repeat(81)]) {
    assert.throws(() => presetProfileName(invalid), /preset profile requires/);
  }
});

test('Exported picker entries have independent paths and preserve the existing default and user profiles', async (t) => {
  const { root } = await fixture(t);
  const source = 'default_permissions = "personal" # keep default\n[permissions.personal.network]\nenabled = true\n';
  const result = exportPresetProfiles(source, [input(root, 'First', 'first'), input(root, 'Second', 'second')]);
  const value = parsed(result.text);
  assert.equal(value.default_permissions, 'personal');
  assert.match(result.text, /^default_permissions = "personal" # keep default\n/);
  assert.equal(value.permissions.personal.network.enabled, true);
  for (const [name, selected, disabled] of [['First', 'first', 'second'], ['Second', 'second', 'first']]) {
    const exported = result.profiles.find(profile => profile.presetName === name)!;
    const profile = value.permissions[exported.profileName];
    assert.equal(profile.description, undefined, 'The native picker should show one short label without a repeated subtitle');
    assert.equal(exported.profileName, `${name} - AgentScope`);
    assert.equal(profile.filesystem[path.join(root, selected)], 'write');
    assert.equal(profile.filesystem[path.join(root, disabled)], 'deny');
    assert.equal(profile.filesystem[path.join(root, 'AGENTS.md')], undefined);
    assert.equal(profile.filesystem[path.join(root, '.agentscope', 'access.md')], undefined);
  }
  assert.equal(result.profiles.length, 2);
  assert.equal(result.broadReadAccess, false);
});

test('Publishing presets neither inserts a default nor changes a root selector represented with a quoted key', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  assert.equal(parsed(exportPresetProfiles('', [preset]).text).default_permissions, undefined);
  const source = '"default_permissions" = "personal" # chosen\n';
  const exported = exportPresetProfiles(source, [preset]).text;
  assert.ok(exported.startsWith(source));
  assert.equal(parsed(exported).default_permissions, 'personal');
});

test('Exporting presets repeatedly is idempotent and does not remove older chat profile entries', async (t) => {
  const { root } = await fixture(t);
  const presets = [input(root, 'First', 'first'), input(root, 'Second', 'second')];
  const first = exportPresetProfiles('', presets);
  assert.equal(exportPresetProfiles(first.text, presets).text, first.text);
  const retained = parsed(exportPresetProfiles(first.text, [presets[0]]).text);
  assert.equal(retained.permissions[first.profiles[1].profileName].filesystem[path.join(root, 'second')], 'write');
});

test('Short IDs preserve label punctuation and Unicode without introducing TOML fields', async (t) => {
  const { root } = await fixture(t);
  const name = 'پروژه "One" \\ test';
  const result = exportPresetProfiles('', [input(root, name, 'first')]);
  assert.equal(parsed(result.text).permissions[result.profiles[0].profileName].description, undefined);
  assert.equal(result.profiles[0].description, `${name} - AgentScope`);
  assert.equal(result.profiles[0].profileName, `${name} - AgentScope`);
});

test('A user-owned profile collision and duplicate batch entries fail closed', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  const exported = exportPresetProfiles('', [preset]);
  const source = `[permissions.${JSON.stringify(exported.profiles[0].profileName)}.network]\nenabled = true\n`;
  assert.throws(() => exportPresetProfiles(source, [preset]), /conflicts|user-owned/);
  assert.throws(() => exportPresetProfiles('', [preset, preset]), /Duplicate preset/);
});

test('Non-selecting updates retain semantic guards on user assignments under managed tables', async (t) => {
  const { root } = await fixture(t);
  const profile = generateProfile(emptyRegistry(), { root, profileName: 'agentscope', allowNetwork: false }).text;
  const source = updateCodexConfig('', profile, 'agentscope', false) + 'quota = 5\n';
  const reversed = '[permissions.agentscope.network]\nenabled = false\n[permissions.agentscope.filesystem]\n":root" = "deny"\n';
  assert.throws(() => updateCodexConfig(source, reversed, 'agentscope', false), /unrelated TOML|table owning/);
});

test('Batch output reports compatibility per preset and can mix independently mapped runtimes', async (t) => {
  const { root } = await fixture(t);
  const native = input(root, 'Native', 'first');
  native.options.runtimeRoot = 'D:\\MyApps';
  native.options.filesystemMode = 'auto';
  const wsl = input(root, 'WSL', 'second');
  wsl.options.runtimeRoot = '/mnt/d/MyApps';
  const result = exportPresetProfiles('', [native, wsl]);
  assert.equal(result.broadReadAccess, true);
  assert.deepEqual(result.profiles.map(profile => profile.broadReadAccess), [true, false]);
  const value = parsed(result.text).permissions;
  assert.equal(value[result.profiles[0].profileName].filesystem[':root'], 'read');
  assert.equal(value[result.profiles[1].profileName].filesystem[':root'], 'deny');
  assert.equal(value[result.profiles[1].profileName].filesystem['/mnt/d/MyApps/second'], 'write');
  assert.ok(result.warnings.some(warning => warning.startsWith('Native:') && warning.includes('OS-level reads')));
});

test('Editing preset grants updates one readable entry and warns about existing chats', async (t) => {
  const { root } = await fixture(t);
  const first = exportPresetProfiles('', [input(root, 'Project', 'first')]);
  const second = exportPresetProfiles(first.text, [input(root, 'Project', 'second')]);
  assert.equal(first.profiles[0].profileName, second.profiles[0].profileName);
  assert.equal(first.profiles[0].description, second.profiles[0].description);
  const values = parsed(second.text).permissions;
  assert.equal(Object.keys(values).length, 1);
  assert.equal(values[second.profiles[0].profileName].filesystem[path.join(root, 'first')], 'deny');
  assert.equal(values[second.profiles[0].profileName].filesystem[path.join(root, 'second')], 'write');
  assert.ok(second.warnings.some(warning => /existing chat/.test(warning)));
  assert.equal(exportPresetProfiles(second.text, [input(root, 'Project', 'second')]).text, second.text);
});

test('Semantically identical grants keep one readable entry when traversal order changes', async (t) => {
  const { root } = await fixture(t);
  const original = input(root, 'Project', 'first');
  original.registry.shared_resources.read_paths = ['alpha', 'beta'];
  const reordered = structuredClone(original);
  reordered.registry.shared_resources.read_paths.reverse();
  reordered.registry.submodules = Object.fromEntries(Object.entries(original.registry.submodules).reverse());
  const first = exportPresetProfiles('', [original]);
  const second = exportPresetProfiles(first.text, [reordered]);
  assert.equal(first.profiles[0].profileName, second.profiles[0].profileName);
  assert.equal(Object.keys(parsed(second.text).permissions).length, 1);
});

test('Legacy hashed profiles migrate to one readable entry and remap a selected default idempotently', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  const old = legacyConfig(preset).replace(/\n/g, '\r\n');
  const source = old + '# user profile\r\n[permissions.personal.network]\r\nenabled = true\r\n';
  const first = exportPresetProfiles(source, [preset]);
  const value = parsed(first.text);
  assert.equal(value.default_permissions, 'First - AgentScope');
  assert.deepEqual(Object.keys(value.permissions).sort(), ['First - AgentScope', 'personal']);
  assert.equal(value.permissions.personal.network.enabled, true);
  assert.ok(first.text.includes('# user profile\r\n'));
  assert.ok(!/(?<!\r)\n/.test(first.text));
  assert.ok(first.warnings.some(warning => /Existing chats.*select the preset again/.test(warning)));
  assert.equal(exportPresetProfiles(first.text, [preset]).text, first.text);
});

test('Migration removes all owned revisions for an exported preset while retaining an unrelated default', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  const source = 'default_permissions = "personal" # retain\n[permissions.personal.network]\nenabled = true\n' +
    legacyConfig(preset, '0123456789ab', false) + legacyConfig(preset, 'abcdef012345', false);
  const result = exportPresetProfiles(source, [preset]);
  assert.equal(parsed(result.text).default_permissions, 'personal');
  assert.deepEqual(Object.keys(parsed(result.text).permissions).sort(), ['First - AgentScope', 'personal']);
  assert.equal(exportPresetProfiles(result.text, [preset]).text, result.text);
});

test('Migration retains unmarked hashed profiles even when their name and description match', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  const oldName = legacyName('First');
  const userText = generateProfile(preset.registry, { ...preset.options, profileName: oldName, description: 'AgentScope: First (012345)' }).text;
  const result = exportPresetProfiles(userText, [preset]);
  assert.ok(result.text.startsWith(userText));
  assert.equal(parsed(result.text).permissions[oldName].description, 'AgentScope: First (012345)');
});

test('Migration refuses to move trailing user assignments out of an old managed table', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  assert.throws(() => exportPresetProfiles(legacyConfig(preset) + 'quota = 5\n', [preset]), /unrelated TOML|user assignments/);
});

test('A managed base profile cannot be overwritten by a preset with the same readable alias', async (t) => {
  const { root } = await fixture(t);
  const preset = input(root, 'First', 'first');
  const name = presetProfileName(preset.name);
  const base = generateProfile(emptyRegistry(), { root, profileName: name, allowNetwork: false });
  const source = updateCodexConfig('', base.text, name);
  assert.throws(() => exportPresetProfiles(source, [preset]), /conflicts with another permission profile/);
  const spoof = source + 'notes = """\n# AgentScope preset: "First"\n"""\n';
  assert.throws(() => exportPresetProfiles(spoof, [preset]), /conflicts with another permission profile/);
});
