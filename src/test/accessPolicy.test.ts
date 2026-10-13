import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCESS_POLICY_FILE, emptyRegistry, isAccessReference, readAccessRegistry,
  readAgentsRegistry, writeAccessFiles, writeAgentsRegistry,
} from '../core/registry';

const begin = '<!-- BEGIN AgentScope access reference -->';
const end = '<!-- END AgentScope access reference -->';
const stripReference = (text: string): string => text.slice(text.indexOf(end) + end.length);
const historicalNotice = 'The linked file is the sole source of AgentScope access settings. Earlier inline AgentScope registries in this file are retained only as historical references and must not be used to grant access. ';
const oldReference = (text: string): string => text.replace(historicalNotice, '');

test('Access policy lives in a portable workspace-relative sidecar with an explicit root anchor', () => {
  const output = writeAccessFiles('', null, emptyRegistry());
  assert.equal(ACCESS_POLICY_FILE, '.agentscope/access.md');
  assert.ok(output.agents.startsWith(begin));
  assert.match(output.agents, /read and follow .*\]\(\.agentscope\/access\.md\)/);
  assert.match(output.agents, /missing, invalid or unreadable, stop/);
  assert.match(output.agents, /sole source of AgentScope access settings/);
  assert.match(output.agents, /historical references and must not be used to grant access/);
  assert.match(output.access, /WORKSPACE_ROOT is the workspace root: the parent of the \.agentscope directory/);
  assert.doesNotMatch(output.access, /WORKSPACE_ROOT is the directory containing this file/);
  assert.equal(readAgentsRegistry(output.agents), null);
  assert.deepEqual(readAccessRegistry(output.agents, output.access), emptyRegistry());
  assert.deepEqual(output.warnings, []);
});

test('Adding a reference preserves arbitrary existing user prose and unrelated JSON byte-for-byte', () => {
  const original = '# Local instructions\n\nUse only the approved compiler.\n\n```jsonc\n{ "unrelated": true }\n```\n\nآخر متن بدون خط جدید';
  const output = writeAccessFiles(original, null, emptyRegistry());
  assert.equal(stripReference(output.agents), `\n\n${original}`);
  assert.equal(output.agents.match(/BEGIN AgentScope access reference/g)?.length, 1);
  assert.ok(!output.agents.includes('"submodules"'));
});

test('Repeated Apply upgrades only recognized generated references without appending duplicates or whitespace', () => {
  const first = writeAccessFiles('# User instructions\n', null, emptyRegistry());
  const second = writeAccessFiles(first.agents, first.access, emptyRegistry());
  assert.equal(second.agents, first.agents);
  assert.equal(second.access, first.access);
  assert.deepEqual(second.warnings, []);
  const refreshed = writeAccessFiles(oldReference(first.agents), first.access, emptyRegistry());
  assert.equal(refreshed.agents, first.agents);
  assert.equal(refreshed.access, first.access);
  const changedWording = first.agents.replace(/Before reading[^\n]+/, 'My custom instruction must survive.');
  assert.throws(() => writeAccessFiles(changedWording, first.access, emptyRegistry()), /customized.*reference.*Move custom text outside.*preserved/i);
});

test('Custom instructions inside reference markers are never silently replaced', () => {
  const initial = writeAccessFiles('# User instructions\n\nKeep this line.\n', null, emptyRegistry());
  const custom = 'Never modify generated files without asking.';
  const variants = [
    initial.agents.replace(end, custom + '\n' + end),
    initial.agents.replace('Before reading', custom + '\nBefore reading'),
    oldReference(initial.agents).replace(end, custom + '\n' + end),
    '\uFEFF' + initial.agents.replace(end, custom + '\n' + end).replace(/\n/g, '\r\n'),
  ];
  for (const main of variants) {
    assert.throws(() => readAccessRegistry(main, initial.access), /customized.*reference.*preserved/i);
    assert.throws(() => writeAccessFiles(main, initial.access, emptyRegistry()), /Move custom text outside the access reference markers/i);
    assert.ok(main.includes(custom));
    assert.equal(initial.access, writeAccessFiles('', null, emptyRegistry()).access);
  }
});

test('A complete owned reference farther down the file moves to the beginning and retains every other byte', () => {
  const first = writeAccessFiles('', null, emptyRegistry());
  const block = first.agents.trimEnd();
  const before = '# Instructions\nKeep the spaces.  \n\n';
  const after = '\n\nLast line without newline';
  const result = writeAccessFiles(before + block + after, first.access, emptyRegistry());
  assert.equal(result.agents, `${block}\n\n${before}${after}`);
  assert.equal(writeAccessFiles(result.agents, result.access, emptyRegistry()).agents, result.agents);
});

test('CRLF and the main file BOM survive reference creation, migration and repeat Apply', () => {
  const original = '\uFEFF# Instructions\r\n\r\nKeep this text.\r\n';
  const first = writeAccessFiles(original, null, emptyRegistry());
  assert.ok(first.agents.startsWith(`\uFEFF${begin}\r\n`));
  assert.equal(stripReference(first.agents), `\r\n\r\n${original.slice(1)}`);
  assert.equal(first.agents.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(first.access.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(writeAccessFiles(first.agents, first.access, emptyRegistry()).agents, first.agents);
  const legacy = '\uFEFF' + writeAgentsRegistry('# User\r\n', emptyRegistry());
  const migrated = writeAccessFiles(legacy, null, emptyRegistry());
  assert.ok(migrated.agents.startsWith('\uFEFF'));
  assert.equal(stripReference(migrated.agents), '\r\n\r\n' + legacy.slice(1));
  assert.deepEqual(readAccessRegistry(migrated.agents, migrated.access), emptyRegistry());
  assert.equal(writeAccessFiles(migrated.agents, migrated.access, emptyRegistry()).agents, migrated.agents);
});

test('Canonical legacy policies copy their exact JSONC fence and retain the entire original main file', () => {
  const original = writeAgentsRegistry('# Original workflow\n\nKeep this instruction.\n', emptyRegistry());
  const legacy = original
    .replace('```json\n', '```jsonc\n')
    .replace('{\n', '{\n  // User comment retained exactly\n  "metadata": { "owner": "local", "version": 7 },\n')
    .replace('"write_paths": []', '"write_paths": [], "description": "Keep this resource annotation"')
    + '\nEnd of user prose.\n';
  const fence = legacy.slice(legacy.indexOf('```jsonc'), legacy.indexOf('```\n', legacy.indexOf('```jsonc') + 3) + 4);
  const registry = readAgentsRegistry(legacy)!;
  const result = writeAccessFiles(legacy, null, registry);
  assert.ok(result.access.endsWith(fence));
  assert.equal(stripReference(result.agents), '\n\n' + legacy);
  assert.match(result.agents, /AgentScope managed instructions|"submodules"|User comment/);
  assert.match(result.access, /User comment retained exactly/);
  assert.deepEqual(readAccessRegistry(result.agents, result.access)?.metadata, { owner: 'local', version: 7 });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Copied.*all original AGENTS.md text.*retained/i);
  const again = writeAccessFiles(result.agents, result.access, registry);
  assert.equal(again.agents, result.agents);
  assert.equal(again.access, result.access);
  assert.deepEqual(again.warnings, []);
});

test('Inline registries remain backward-readable but user-owned unmarked registries cannot be removed', () => {
  const unmarked = '# User policy\n\n```json\n' + JSON.stringify(emptyRegistry()) + '\n```\n';
  assert.deepEqual(readAccessRegistry(unmarked, null), emptyRegistry());
  assert.throws(() => writeAccessFiles(unmarked, null, emptyRegistry()), /user-owned inline.*will not copy or reinterpret.*migrate/i);
  const bomUnmarked = '\uFEFF' + unmarked.slice(unmarked.indexOf('```'));
  assert.deepEqual(readAccessRegistry(bomUnmarked, null), emptyRegistry());
  assert.throws(() => writeAccessFiles(bomUnmarked, null, emptyRegistry()), /user-owned inline/i);
});

test('Customized legacy owned instructions are preserved by refusing automatic migration', () => {
  const legacy = writeAgentsRegistry('', emptyRegistry()).replace('Empty lists grant no access.', 'Empty lists grant full access.');
  assert.throws(() => readAccessRegistry(legacy, null), /customized.*Move custom instructions/i);
  assert.throws(() => writeAccessFiles(legacy, null, emptyRegistry()), /customized.*existing content was preserved/i);
});

test('Missing, invalid or unreadable linked policies never fall back to broad access', () => {
  const output = writeAccessFiles('', null, emptyRegistry());
  assert.throws(() => readAccessRegistry(output.agents, null), /file is missing/i);
  assert.throws(() => writeAccessFiles(output.agents, null, emptyRegistry()), /file is missing/i);
  assert.throws(() => readAccessRegistry(output.agents, output.access.replace('"submodules": {}', '"submodules": {')), /invalid JSON/i);
  assert.throws(() => readAccessRegistry(output.agents, output.access.slice(0, output.access.indexOf('```json'))), /valid registry.*immediately after/i);
});

test('Existing empty or unrelated sidecars are never overwritten', () => {
  for (const existing of ['', '# This is my file\n', '```json\n' + JSON.stringify(emptyRegistry()) + '\n```\n']) {
    assert.throws(() => readAccessRegistry('', existing), /already exists without a valid AgentScope managed policy/i);
    assert.throws(() => writeAccessFiles('# My AGENTS\n', existing, emptyRegistry()), /user-owned file.*existing content was preserved/i);
  }
});

test('Sidecar edits preserve user prose, BOM, JSONC comments, metadata and line endings', () => {
  const initial = writeAccessFiles('', null, emptyRegistry());
  const existing = '\uFEFF# A user explanation\r\n\r\n' + initial.access
    .replace('```json\n', '```jsonc\n')
    .replace('{\n', '{\n  // Keep this comment\n  "metadata": { "owner": "local" },\n')
    .replace(/\n/g, '\r\n') + '\r\nUser suffix.\r\n';
  const next = readAccessRegistry(initial.agents, existing)!;
  next.shared_resources.read_paths = ['Instructions'];
  const output = writeAccessFiles(initial.agents, existing, next);
  assert.ok(output.access.startsWith('\uFEFF# A user explanation\r\n\r\n'));
  assert.ok(output.access.endsWith('\r\nUser suffix.\r\n'));
  assert.match(output.access, /\/\/ Keep this comment/);
  assert.deepEqual(readAccessRegistry(output.agents, output.access)?.metadata, { owner: 'local' });
  assert.deepEqual(readAccessRegistry(output.agents, output.access)?.shared_resources.read_paths, ['Instructions']);
  assert.equal(output.access.replace(/\r\n/g, '').includes('\n'), false);
});

test('Customized or disconnected sidecar rule blocks fail closed instead of losing user edits', () => {
  const initial = writeAccessFiles('', null, emptyRegistry());
  const changed = initial.access.replace('Empty lists grant no access.', 'Empty lists grant full access.');
  assert.throws(() => readAccessRegistry(initial.agents, changed), /customized.*restore its original text/i);
  assert.throws(() => writeAccessFiles(initial.agents, changed, emptyRegistry()), /customized/i);
  const disconnected = initial.access.replace('```json\n', 'User paragraph between the policy and registry.\n\n```json\n');
  assert.throws(() => readAccessRegistry(initial.agents, disconnected), /immediately after/i);
});

test('Inline and sidecar policies without the new authority reference remain rejected until reviewed', () => {
  const split = writeAccessFiles('', null, emptyRegistry());
  const marked = writeAgentsRegistry('', emptyRegistry());
  assert.throws(() => readAccessRegistry(marked, split.access), /Both AGENTS.md.*contain access registries/i);
  assert.throws(() => writeAccessFiles(marked, split.access, emptyRegistry()), /one authoritative policy/i);
  assert.throws(() => readAccessRegistry(oldReference(split.agents) + marked, split.access), /both an access reference and an inline registry/i);
  assert.throws(() => readAccessRegistry(oldReference(split.agents) + '\n```json\n' + JSON.stringify(emptyRegistry()) + '\n```\n', split.access), /both an access reference and an inline registry/i);
});

test('Retained historical inline grants never override or broaden the linked policy', () => {
  const historic = emptyRegistry();
  historic.shared_resources.read_paths = ['PreviouslyReadable'];
  historic.shared_resources.write_paths = ['PreviouslyWritable'];
  historic.submodules.disabledNow = { path: 'project', enabled: true, restrict_paths: false,
    read_paths: [], write_paths: [], instruction_file: null };
  const legacy = writeAgentsRegistry('# Keep all original instructions.\n', historic);
  const active = structuredClone(historic);
  active.shared_resources = { read_paths: [], write_paths: [] };
  active.submodules.disabledNow.enabled = false;
  const copied = writeAccessFiles(legacy, null, active);
  assert.equal(stripReference(copied.agents), '\n\n' + legacy);
  assert.match(copied.agents, /PreviouslyReadable|PreviouslyWritable/);
  assert.deepEqual(readAccessRegistry(copied.agents, copied.access), active);
  const changed = structuredClone(active);
  changed.shared_resources.read_paths = ['OnlyThisFile.md'];
  const next = writeAccessFiles(copied.agents, copied.access, changed);
  assert.equal(next.agents, copied.agents);
  assert.deepEqual(readAccessRegistry(next.agents, next.access), changed);
  assert.throws(() => readAccessRegistry(next.agents, null), /file is missing/i);
  assert.throws(() => readAccessRegistry(next.agents, next.access.replace('"submodules": {', '"submodules": [')), /invalid JSON/i);
});

test('Historical inline JSON is never parsed or used as a fallback after explicit delegation', () => {
  const split = writeAccessFiles('', null, emptyRegistry());
  const legacy = writeAgentsRegistry('', emptyRegistry());
  const historicalVariants = [
    legacy.replace('Empty lists grant no access.', 'My custom legacy policy prose must stay.'),
    legacy.replace('"submodules": {}', '"submodules": {'),
    legacy + '\n```json\n' + JSON.stringify(emptyRegistry()) + '\n```\n',
  ];
  for (const historical of historicalVariants) {
    const main = split.agents + '\n' + historical;
    assert.deepEqual(readAccessRegistry(main, split.access), emptyRegistry());
    assert.equal(writeAccessFiles(main, split.access, emptyRegistry()).agents, main);
    assert.throws(() => readAccessRegistry(main, null), /file is missing/i);
    assert.throws(() => readAccessRegistry(main, '# Not an AgentScope policy\n'), /without a valid AgentScope managed policy/i);
  }
});

test('A valid managed sidecar can be loaded before adding its main reference', () => {
  const initial = writeAccessFiles('', null, emptyRegistry());
  assert.deepEqual(readAccessRegistry('# User instructions\n', initial.access), emptyRegistry());
  const output = writeAccessFiles('# User instructions\n', initial.access, emptyRegistry());
  assert.equal(output.access, initial.access);
  assert.ok(isAccessReference(output.agents));
});

test('Duplicate, partial, reversed and nested AgentScope markers fail closed', () => {
  const split = writeAccessFiles('', null, emptyRegistry());
  const malformed = [
    split.agents + split.agents,
    begin + '\nShort text\n',
    end + '\n',
    `${end}\n${begin}\n`,
    `${begin}\n${begin}\n${end}\n${end}\n`,
    '<!-- BEGIN AgentScope access reference --\n',
    `${begin}\n<!-- END AgentScope managed instructions -->\n`,
  ];
  for (const text of malformed) {
    assert.throws(() => isAccessReference(text), /marker|managed block/i);
    assert.throws(() => readAccessRegistry(text, split.access), /marker|managed block/i);
    assert.throws(() => writeAccessFiles(text, split.access, emptyRegistry()), /marker|managed block/i);
  }
  assert.throws(() => readAccessRegistry(split.agents, split.access + split.access), /duplicate.*markers/i);
});

test('Marker-looking lines in nested fenced examples are untouched user prose', () => {
  const examples = '# User guide\n\n````markdown\n' + begin + '\n```json\n' + JSON.stringify(emptyRegistry()) + '\n```\n' + end + '\n````\n\n~~~text\n<!-- BEGIN AgentScope managed instructions -->\n~~~\n';
  assert.equal(isAccessReference(examples), false);
  assert.equal(readAccessRegistry(examples, null), null);
  const output = writeAccessFiles(examples, null, emptyRegistry());
  assert.equal(stripReference(output.agents), '\n\n' + examples);
  assert.deepEqual(readAccessRegistry(output.agents, output.access), emptyRegistry());
});

test('Invalid standalone legacy blocks and policy blocks placed in main AGENTS are refused', () => {
  const split = writeAccessFiles('', null, emptyRegistry());
  const legacy = writeAgentsRegistry('', emptyRegistry());
  const missingFence = legacy.slice(0, legacy.indexOf('```json'));
  assert.throws(() => readAccessRegistry(missingFence, null), /valid registry.*immediately after/i);
  assert.throws(() => writeAccessFiles(split.access, null, emptyRegistry()), /belongs in \.agentscope\/access\.md/i);
});
