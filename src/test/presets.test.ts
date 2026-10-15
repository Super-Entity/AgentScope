import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { emptyRegistry } from '../core/registry';
import { deletePreset, readPresets, ScopePreset, writePreset } from '../presets';
import { directoryLink, fixture, project } from './helpers';

function snapshot(): ScopePreset {
  const registry = emptyRegistry();
  registry.description = 'Custom registry metadata';
  registry.shared_resources.read_paths = ['Instructions'];
  registry.shared_resources.category = 'Supporting files';
  registry.submodules.library = project({ path: 'packages/library', enabled: false, read_paths: [], write_paths: [] });
  registry.submodules.library.description = 'Preserve this project note';
  return {
    registry, hidden: { library: true }, resourceHidden: { 'Instructions/private.md': true, 'README.md': false },
    options: { generateCodexProfile: true, profileName: 'agentscope', excludeFromSearch: false, allowNetwork: false },
  };
}

const storePath = (root: string): string => path.join(root, '.vscode', 'agentscope-presets.json');

test('Reading missing presets does not create a configuration directory or policy files', async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await readPresets(root), { version: 1, presets: {} });
  assert.deepEqual(await fs.readdir(root), []);
});

test('Two named preset snapshots round trip with relative scopes, visibility, options and custom registry fields', async (t) => {
  const { root } = await fixture(t);
  const first = snapshot();
  const second = snapshot();
  second.hidden.library = false;
  second.registry.shared_resources.read_paths = ['Instructions/Writer.md'];
  second.options.allowNetwork = true;
  second.options.codexFilesystemMode = 'strict';
  const initial = structuredClone(first);
  await writePreset(root, 'Writing', first);
  await writePreset(root, 'مرور مقاله', second);
  assert.deepEqual(await readPresets(root), { version: 1, presets: { Writing: first, 'مرور مقاله': second } });
  assert.deepEqual(first, initial);
  assert.deepEqual(await fs.readdir(root), ['.vscode']);
  assert.deepEqual(await fs.readdir(path.join(root, '.vscode')), ['agentscope-presets.json']);
  const read = await readPresets(root);
  read.presets.Writing.registry.shared_resources.read_paths.push('unrelated.md');
  assert.deepEqual((await readPresets(root)).presets.Writing, initial);
});

test('Replacing a preset preserves other presets, JSONC comments, root metadata and snapshot annotations', async (t) => {
  const { root } = await fixture(t);
  const first = snapshot();
  const second = snapshot();
  first.note = 'User annotation retained';
  await fs.mkdir(path.join(root, '.vscode'));
  const original = `{
  // Shared team notes remain.
  "version": 1,
  "owner": "Local workspace",
  "presets": {
    "Writing": ${JSON.stringify(first)},
    // This other preset must remain as it was.
    "Review": ${JSON.stringify(second)}
  }
}\n`;
  await fs.writeFile(storePath(root), original);
  const replaced = snapshot();
  replaced.registry.shared_resources.write_paths = ['Instructions/Writer.md'];
  replaced.options.profileName = 'writing';
  await writePreset(root, 'Writing', replaced);
  const raw = await fs.readFile(storePath(root), 'utf8');
  assert.match(raw, /Shared team notes remain/);
  assert.match(raw, /This other preset must remain/);
  const read = await readPresets(root);
  assert.equal(read.owner, 'Local workspace');
  assert.equal(read.presets.Writing.note, 'User annotation retained');
  assert.deepEqual(read.presets.Review, second);
  assert.deepEqual(read.presets.Writing.registry, replaced.registry);
  assert.deepEqual(read.presets.Writing.options, replaced.options);
});

test('Saving an equivalent preset preserves inner JSONC comments and exact bytes without an atomic write', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const first = snapshot();
  const presetText = JSON.stringify(first, null, '\t')
    .replace('"registry": {', '"registry": { // This inline registry comment survives.')
    .replace('"allowNetwork": false', '// Network explanation stays in this preset.\r\n\t\t"allowNetwork": false');
  const original = `// Workspace notes\r\n{\r\n\t"version": 1,\r\n\t"presets": {\r\n\t\t"Writing": ${presetText}\r\n\t}\r\n}\r\n`;
  await fs.writeFile(storePath(root), original);
  const same = (await readPresets(root)).presets.Writing;
  t.mock.method(fs, 'rename', async () => { throw new Error('An equivalent preset must not be written'); });
  await writePreset(root, 'Writing', same);
  assert.equal(await fs.readFile(storePath(root), 'utf8'), original);
});

test('Changed preset fields and array entries preserve nested comments, metadata and other snapshots', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const first = snapshot();
  first.registry.submodules.library.write_paths = ['drafts/one.md', 'drafts/two.md'];
  first.registry.submodules.library.audit = { owner: 'Keep module annotation' };
  first.registry.annotation = { owner: 'Keep registry annotation' };
  Object.defineProperty(first.options, 'annotation', { value: { owner: 'Keep options annotation' }, enumerable: true });
  Object.defineProperty(first, '__proto__', { value: { note: 'Treat as ordinary metadata' }, enumerable: true });
  const firstRaw = JSON.stringify(first, null, 2)
    .replace('"registry": {', '"registry": { // Registry explanation retained.')
    .replace('"shared_resources": {', '"shared_resources": { // Shared resource explanation retained.')
    .replace('"library": {', '"library": { // Module explanation retained.')
    .replace('"drafts/one.md",', '"drafts/one.md", // This path entry comment stays.')
    .replace('"allowNetwork": false,', '"allowNetwork": false, // Network explanation retained.');
  const otherRaw = JSON.stringify(snapshot(), null, '\t').replace('"registry": {', '"registry": { // Other snapshot stays byte-for-byte.');
  const original = `{
  "version": 1,
  "owner": "Keep root annotation",
  "presets": {
    "Writing": ${firstRaw},
    "Review": ${otherRaw}
  }
}\n`;
  await fs.writeFile(storePath(root), original);
  const next = snapshot();
  delete next.registry.description;
  delete next.registry.shared_resources.category;
  delete next.registry.submodules.library.description;
  next.registry.submodules.library.write_paths = ['drafts/updated.md', 'drafts/two.md', 'drafts/new.md'];
  next.registry.shared_resources.write_paths = ['Instructions/Writer.md'];
  next.options.allowNetwork = true;
  await writePreset(root, 'Writing', next);
  const raw = await fs.readFile(storePath(root), 'utf8');
  for (const text of ['Registry explanation retained.', 'Shared resource explanation retained.', 'Module explanation retained.',
    'This path entry comment stays.', 'Network explanation retained.']) assert.ok(raw.includes(text), text);
  assert.ok(raw.includes(`"Review": ${otherRaw}`));
  const read = await readPresets(root);
  assert.equal(read.owner, 'Keep root annotation');
  assert.deepEqual(read.presets.Review, snapshot());
  const saved = read.presets.Writing;
  assert.deepEqual(saved.registry.submodules.library.write_paths, next.registry.submodules.library.write_paths);
  assert.deepEqual(saved.registry.shared_resources.write_paths, ['Instructions/Writer.md']);
  assert.equal(saved.registry.description, 'Custom registry metadata');
  assert.equal(saved.registry.shared_resources.category, 'Supporting files');
  assert.equal(saved.registry.submodules.library.description, 'Preserve this project note');
  assert.deepEqual(saved.registry.annotation, { owner: 'Keep registry annotation' });
  assert.deepEqual(saved.registry.submodules.library.audit, { owner: 'Keep module annotation' });
  assert.deepEqual((saved.options as unknown as Record<string, unknown>).annotation, { owner: 'Keep options annotation' });
  assert.equal(saved.options.allowNetwork, true);
  assert.ok(Object.hasOwn(saved, '__proto__'));
  assert.deepEqual(saved.__proto__, { note: 'Treat as ordinary metadata' });
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
});

test('Preset maps retain intentional project and visibility removals while leaving unrelated comments intact', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const first = snapshot();
  first.registry.submodules.other = project({ path: 'other', enabled: false, read_paths: [], write_paths: [] });
  first.hidden.other = false;
  const original = JSON.stringify({ version: 1, presets: { Writing: first } }, null, 2)
    .replace('"profileName": "agentscope",', '"profileName": "agentscope", // Retain this unrelated options note.');
  await fs.writeFile(storePath(root), original);
  const next = snapshot();
  next.registry.submodules = { other: first.registry.submodules.other };
  next.hidden = { other: true };
  next.resourceHidden = { 'README.md': false };
  await writePreset(root, 'Writing', next);
  const saved = (await readPresets(root)).presets.Writing;
  assert.deepEqual(Object.keys(saved.registry.submodules), ['other']);
  assert.deepEqual(saved.hidden, { other: true });
  assert.deepEqual(saved.resourceHidden, { 'README.md': false });
  assert.match(await fs.readFile(storePath(root), 'utf8'), /Retain this unrelated options note/);
});

test('Shrinking a preset path array keeps both neighbouring and removed-entry comments without restoring the removed grant', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  const first = snapshot();
  first.registry.submodules.library.write_paths = ['drafts/keep.md', 'drafts/remove.md'];
  const original = JSON.stringify({ version: 1, presets: { Writing: first } }, null, 2)
    .replace('"drafts/keep.md",', '"drafts/keep.md", // Keep this explanation about the retained path.')
    .replace('"drafts/remove.md"', '// Preserve this user annotation too.\n          "drafts/remove.md"');
  await fs.writeFile(storePath(root), original);
  const next = snapshot();
  next.registry.submodules.library.write_paths = ['drafts/keep.md'];
  await writePreset(root, 'Writing', next);
  const raw = await fs.readFile(storePath(root), 'utf8');
  assert.match(raw, /Keep this explanation about the retained path/);
  assert.match(raw, /Preserve this user annotation too/);
  assert.deepEqual((await readPresets(root)).presets.Writing.registry.submodules.library.write_paths, ['drafts/keep.md']);
});

test('Final preset mutation validation runs after reading and can reject save and deletion without changing the file', async (t) => {
  const { root } = await fixture(t);
  await writePreset(root, 'Writing', snapshot());
  const before = await fs.readFile(storePath(root), 'utf8');
  const next = snapshot();
  next.options.allowNetwork = true;
  let validations = 0;
  const reject = async (): Promise<void> => { validations++; throw new Error('Editor became dirty after preset selection'); };
  await assert.rejects(writePreset(root, 'Writing', next, reject), /Editor became dirty/);
  await assert.rejects(deletePreset(root, 'Writing', reject), /Editor became dirty/);
  assert.equal(validations, 2);
  assert.equal(await fs.readFile(storePath(root), 'utf8'), before);
});

test('An ordinary workspace directory replacement after reading cannot receive stale preset writes', async (t) => {
  const { base, root } = await fixture(t);
  await writePreset(root, 'Writing', snapshot());
  const before = await fs.readFile(storePath(root), 'utf8');
  const retained = path.join(base, 'retained-workspace');
  const next = snapshot();
  next.options.allowNetwork = true;
  await assert.rejects(writePreset(root, 'Writing', next, async () => {
    await fs.rename(root, retained);
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, '.vscode'));
    await fs.writeFile(storePath(root), before);
  }), /Workspace root directory changed/);
  assert.equal(await fs.readFile(storePath(root), 'utf8'), before);
  assert.equal(await fs.readFile(storePath(retained), 'utf8'), before);
});

test('Deleting one preset leaves other snapshots and metadata intact and a missing name is harmless', async (t) => {
  const { root } = await fixture(t);
  await writePreset(root, 'Writing', snapshot());
  await writePreset(root, 'Review', snapshot());
  await deletePreset(root, 'Writing');
  const read = await readPresets(root);
  assert.deepEqual(Object.keys(read.presets), ['Review']);
  const before = await fs.readFile(storePath(root), 'utf8');
  await deletePreset(root, 'Missing');
  assert.equal(await fs.readFile(storePath(root), 'utf8'), before);
  await deletePreset(root, 'Review');
  assert.deepEqual(await readPresets(root), { version: 1, presets: {} });
});

test('Malformed stores, unsupported versions and duplicate keys are refused without overwriting user contents', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.vscode'));
  for (const raw of ['{broken', '{"version":2,"presets":{}}', '{"version":1,"presets":[]}', '{"version":1,"version":1,"presets":{}}']) {
    await fs.writeFile(storePath(root), raw);
    await assert.rejects(readPresets(root), /invalid JSON|version 1|duplicate/);
    await assert.rejects(writePreset(root, 'Writing', snapshot()), /invalid JSON|version 1|duplicate/);
    assert.equal(await fs.readFile(storePath(root), 'utf8'), raw);
  }
});

test('Preset names reject reserved keys, empty or padded text and control characters before writing', async (t) => {
  const { root } = await fixture(t);
  for (const name of ['', ' ', ' Padded', 'Padded ', 'line\nbreak', 'x'.repeat(81), '__proto__', 'constructor', 'prototype']) {
    await assert.rejects(writePreset(root, name, snapshot()), /preset name/);
    await assert.rejects(deletePreset(root, name), /preset name/);
  }
  assert.deepEqual(await fs.readdir(root), []);
  await fs.mkdir(path.join(root, '.vscode'));
  const raw = `{"version":1,"presets":{"__proto__":${JSON.stringify(snapshot())}}}`;
  await fs.writeFile(storePath(root), raw);
  await assert.rejects(readPresets(root), /preset name/);
});

test('Invalid preset scope paths, project visibility or options cannot create or alter a store', async (t) => {
  const { root } = await fixture(t);
  const cases: Array<{ preset: ScopePreset; error: RegExp }> = [];
  const traversal = snapshot();
  traversal.registry.shared_resources.read_paths = ['../outside'];
  cases.push({ preset: traversal, error: /parent|traverse/ });
  const absolute = snapshot();
  absolute.registry.submodules.library.path = path.join(root, 'library');
  cases.push({ preset: absolute, error: /Absolute/ });
  const hiddenProject = snapshot();
  hiddenProject.hidden.library = 'true' as unknown as boolean;
  cases.push({ preset: hiddenProject, error: /visibility/ });
  const unknownProject = snapshot();
  unknownProject.hidden.other = true;
  cases.push({ preset: unknownProject, error: /visibility/ });
  const badOptions = snapshot();
  badOptions.options.allowNetwork = 'false' as unknown as boolean;
  cases.push({ preset: badOptions, error: /options/ });
  const badProfile = snapshot();
  badProfile.options.profileName = '../run-command';
  cases.push({ preset: badProfile, error: /options/ });
  const badFilesystemMode = snapshot();
  badFilesystemMode.options.codexFilesystemMode = 'silent-full-access' as NonNullable<ScopePreset['options']['codexFilesystemMode']>;
  cases.push({ preset: badFilesystemMode, error: /filesystem mode/ });
  for (const item of cases) {
    await assert.rejects(writePreset(root, 'Writing', item.preset), item.error);
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('Workspace resource visibility cannot target project roots, ancestors, metadata, globs or traversal', async (t) => {
  const { root } = await fixture(t);
  for (const resource of ['.', 'packages', 'packages/library', 'packages/library/private.md', '.git', 'Instructions/.git', '**/cache', '../outside']) {
    const preset = snapshot();
    preset.resourceHidden = { [resource]: true };
    await assert.rejects(writePreset(root, 'Writing', preset), /visibility|wildcard|traverse|parent/);
  }
  const badBoolean = snapshot();
  badBoolean.resourceHidden = { Instructions: 'true' as unknown as boolean };
  await assert.rejects(writePreset(root, 'Writing', badBoolean), /visibility/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Linked configuration directories are rejected for both reading and writing without touching their destinations', async (t) => {
  const { root, outside } = await fixture(t);
  const raw = JSON.stringify({ version: 1, presets: { Existing: snapshot() } });
  await fs.writeFile(path.join(outside, 'agentscope-presets.json'), raw);
  await directoryLink(outside, path.join(root, '.vscode'));
  await assert.rejects(readPresets(root), /symbolic link|junction/);
  await assert.rejects(writePreset(root, 'Writing', snapshot()), /symbolic link|junction/);
  assert.equal(await fs.readFile(path.join(outside, 'agentscope-presets.json'), 'utf8'), raw);
});

test('An internal configuration directory alias is also refused', async (t) => {
  const { root } = await fixture(t);
  const actual = path.join(root, 'editor-config');
  await fs.mkdir(actual);
  await directoryLink(actual, path.join(root, '.vscode'));
  await assert.rejects(readPresets(root), /symbolic link|junction/);
  await assert.rejects(writePreset(root, 'Writing', snapshot()), /symbolic link|junction/);
  assert.deepEqual(await fs.readdir(actual), []);
});

test('A selected workspace replaced by a junction cannot redirect preset reads, writes or deletion', async (t) => {
  const { root, outside } = await fixture(t);
  await writePreset(root, 'Original', snapshot());
  await writePreset(outside, 'Other workspace', snapshot());
  const originalStore = await fs.readFile(storePath(root), 'utf8');
  const otherStore = await fs.readFile(storePath(outside), 'utf8');
  const retained = path.join(path.dirname(root), 'retained-workspace');
  await fs.rename(root, retained);
  await directoryLink(outside, root);

  await assert.rejects(readPresets(root), /Workspace root changed/);
  await assert.rejects(writePreset(root, 'Stale draft', snapshot()), /Workspace root changed/);
  await assert.rejects(deletePreset(root, 'Other workspace'), /Workspace root changed/);
  assert.equal(await fs.readFile(storePath(retained), 'utf8'), originalStore);
  assert.equal(await fs.readFile(storePath(outside), 'utf8'), otherStore);
});

test('A linked preset file is refused before reading its contents even when its canonical target matches', async (t) => {
  const { root } = await fixture(t);
  const target = storePath(root);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(target, '{"version":1,"presets":{}}');
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const info = await lstat(...args);
    if (String(args[0]) === target) return { ...info, isSymbolicLink: () => true, isFile: () => true };
    return info;
  });
  t.mock.method(fs, 'readFile', async () => { throw new Error('A linked file must not be read'); });
  await assert.rejects(readPresets(root), /regular file/);
  await assert.rejects(writePreset(root, 'Writing', snapshot()), /regular file/);
});

test('A concurrent preset-file edit is preserved and rejects a stale atomic write', async (t) => {
  const { root } = await fixture(t);
  await writePreset(root, 'Writing', snapshot());
  const target = storePath(root);
  const concurrent = JSON.stringify({ version: 1, owner: 'Concurrent edit retained', presets: { Other: snapshot() } });
  const readFile = fs.readFile.bind(fs);
  let edited = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const text = await readFile(...args);
    if (!edited && String(args[0]) === target) {
      edited = true;
      await fs.writeFile(target, concurrent);
    }
    return text;
  });
  const changed = snapshot();
  changed.options.allowNetwork = true;
  await assert.rejects(writePreset(root, 'Writing', changed), /changed.*refresh/);
  assert.equal(await readFile(target, 'utf8'), concurrent);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['agentscope-presets.json']);
});

test('A failed atomic rename retains the old preset file and cleans temporary files', async (t) => {
  const { root } = await fixture(t);
  await writePreset(root, 'Writing', snapshot());
  const target = storePath(root);
  const original = await fs.readFile(target, 'utf8');
  t.mock.method(fs, 'rename', async () => { throw new Error('Atomic rename blocked'); });
  await assert.rejects(writePreset(root, 'Review', snapshot()), /Atomic rename blocked/);
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['agentscope-presets.json']);
});
