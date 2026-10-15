import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from '../configuration';
import { emptyRegistry, parseJsoncStrict } from '../core/registry';
import { generateProfile } from '../core/profile';
import { Registry } from '../types';
import { project, registry } from './helpers';

const stored = (value: unknown, extras: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, registry: value, ...extras }, null, 2) + '\n';

test('New editor configuration stores its registry without instruction or access-policy files', () => {
  assert.equal(SCOPE_CONFIGURATION_FILE, '.vscode/agentscope.json');
  const value = registry();
  const text = writeScopeConfiguration(null, value);
  assert.deepEqual(readScopeConfiguration(text), value);
  assert.equal(text, stored(value));
  assert.equal(writeScopeConfiguration(text, value), text, 'Unchanged configuration must remain byte-identical');
});

test('Scope edits preserve top-level annotations and comments at every registry depth', () => {
  const original = `{
  // Team configuration
  "version": 1,
  "owner": { "name": "team", "__proto__": "literal metadata" },
  "registry": {
    // Shared selections
    "shared_resources": { "read_paths": [/* shared note */ "Instructions"], "write_paths": [], "note": "keep shared metadata" },
    "annotation": { "reviewer": "alice", "flags": ["keep"] },
    "submodules": {
      "project": {
        "path": "project",
        "enabled": true, // enabled note
        "restrict_paths": true,
        "read_paths": ["references" /* old read */],
        "write_paths": ["drafts" /* writable note */],
        "instruction_file": null,
        "metadata": { "owner": "alice", /* owner note */ "color": "blue" }
      }
    }
  }
}
`;
  const next = registry();
  next.submodules.project.enabled = false;
  next.submodules.project.read_paths = [];
  next.submodules.project.write_paths = ['output', 'cache'];
  const updated = writeScopeConfiguration(original, next);
  for (const comment of ['// Team configuration', '// Shared selections', '/* shared note */', '// enabled note', '/* old read */', '/* writable note */', '/* owner note */']) {
    assert.ok(updated.includes(comment), `Lost ${comment}`);
  }
  const parsed = parseJsoncStrict(updated, 'test configuration') as Record<string, unknown>;
  assert.deepEqual(parsed.owner, { name: 'team', ['__proto__']: 'literal metadata' });
  const actual = readScopeConfiguration(updated);
  assert.deepEqual(actual.annotation, { reviewer: 'alice', flags: ['keep'] });
  assert.deepEqual(actual.shared_resources.note, 'keep shared metadata');
  assert.deepEqual(actual.submodules.project.metadata, { owner: 'alice', color: 'blue' });
  assert.equal(actual.submodules.project.enabled, false);
  assert.deepEqual(actual.submodules.project.read_paths, []);
  assert.deepEqual(actual.submodules.project.write_paths, ['output', 'cache']);
});

test('Project membership and permission arrays are authoritative while metadata survives', () => {
  const old = registry({ obsolete: project({ path: 'obsolete' }) });
  old.submodules.project.metadata = { nested: { keep: true, update: 'old' } };
  const original = stored(old).replace('"obsolete": {', '/* removed project note */ "obsolete": {');
  const next = registry();
  next.submodules.project.metadata = { nested: { update: 'new' } };
  next.submodules.project.read_paths = [];
  const updated = writeScopeConfiguration(original, next);
  const actual = readScopeConfiguration(updated);
  assert.equal(Object.hasOwn(actual.submodules, 'obsolete'), false);
  assert.deepEqual(actual.submodules.project.read_paths, []);
  assert.deepEqual(actual.submodules.project.metadata, { nested: { keep: true, update: 'new' } });
  assert.ok(updated.includes('/* removed project note */'));
});

test('Repeated comment tokens survive removal and array replacement without changing metadata', () => {
  const original = stored(registry()).replace('"references"', '/* same note */ "references", /* same note */ "other"');
  const next = registry();
  next.submodules.project.read_paths = [];
  const updated = writeScopeConfiguration(original, next);
  assert.equal(updated.match(/\/\* same note \*\//g)?.length, 2);
  assert.deepEqual(readScopeConfiguration(updated).submodules.project.read_paths, []);
});

test('CRLF and tab-indented JSONC remain in the existing format', () => {
  const original = JSON.stringify({ version: 1, registry: registry(), annotation: 'keep' }, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
  const next = registry();
  next.submodules.extra = project({ path: 'extra', enabled: false, read_paths: [], write_paths: [] });
  const updated = writeScopeConfiguration(original, next);
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(updated.includes('\t\t\t"extra": {\r\n'));
  assert.equal((parseJsoncStrict(updated, 'test') as Record<string, unknown>).annotation, 'keep');
});

test('Unknown versions and malformed configuration shapes are rejected', () => {
  for (const value of [
    null, [], true, 'text', 1,
    { registry: emptyRegistry() },
    { version: 2, registry: emptyRegistry() },
    { version: '1', registry: emptyRegistry() },
    { version: 1, registry: [] },
    { version: 1, registry: null },
    { version: 1, registry: {} },
  ]) {
    assert.throws(() => readScopeConfiguration(JSON.stringify(value)), /version 1|registry/);
  }
  assert.throws(() => readScopeConfiguration('{ "version": 1,'), /invalid JSON/);
});

test('Duplicate keys fail at every nesting level before any write', () => {
  const valid = stored(registry());
  const invalid = [
    valid.replace('"version": 1', '"version": 1, "version": 1'),
    valid.replace('"registry": {', '"registry": {}, "registry": {'),
    valid.replace('"enabled": true', '"enabled": true, "enabled": false'),
    valid.replace('"shared_resources": {', '"annotation": {"owner":1,"owner":2}, "shared_resources": {'),
  ];
  for (const text of invalid) {
    assert.throws(() => readScopeConfiguration(text), /duplicate JSON key/);
    assert.throws(() => writeScopeConfiguration(text, registry()), /duplicate JSON key/);
  }
});

test('Unsafe grants and inconsistent registries are rejected by reads and writes', () => {
  const invalid: Registry[] = [];
  const traversal = registry(); traversal.submodules.project.write_paths = ['../outside']; invalid.push(traversal);
  const absolute = registry(); absolute.shared_resources.read_paths = ['/outside']; invalid.push(absolute);
  const git = registry(); git.submodules.project.read_paths = ['.git/config']; invalid.push(git);
  const shared = registry(); shared.shared_resources.write_paths = ['project']; invalid.push(shared);
  const overlap = registry({ child: project({ path: 'project/child', enabled: false }) }); invalid.push(overlap);
  const flags = registry(); (flags.submodules.project as unknown as Record<string, unknown>).enabled = 'true'; invalid.push(flags);
  for (const value of invalid) {
    assert.throws(() => readScopeConfiguration(stored(value)));
    assert.throws(() => writeScopeConfiguration(null, value));
  }
});

test('Disabled projects remain disabled even when stored paths or metadata exist', () => {
  const value = registry();
  value.submodules.project.enabled = false;
  value.submodules.project.metadata = { visible: true };
  const read = readScopeConfiguration(writeScopeConfiguration(null, value));
  assert.equal(read.submodules.project.enabled, false);
  assert.deepEqual(read.submodules.project.write_paths, ['drafts']);
  const root = path.resolve('test-workspace');
  const output = generateProfile(read, { root, runtimeRoot: '/work/test-workspace', profileName: 'test', allowNetwork: false });
  assert.ok(output.text.includes('"/work/test-workspace/project" = "deny"'));
  assert.ok(!output.text.includes('/work/test-workspace/project/drafts'));
});
