import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { updateExcludesSettings } from '../core/excludes';

test('Visibility edits preserve JSONC comments, broad patterns and unrelated editor settings', () => {
  const source = '{\n  // User preference\n  "editor.tabSize": 4,\n  "files.exclude": { "**/.cache": true, "project": true },\n  "search.exclude": { "archive": true },\n}\n';
  const updated = updateExcludesSettings(source, ['project', 'packages/tool'], { project: false, 'packages/tool': true }, true);
  assert.match(updated, /\/\/ User preference/);
  const result = parse(updated);
  assert.equal(result['editor.tabSize'], 4);
  assert.deepEqual(result['files.exclude'], { '**/.cache': true, project: false, 'packages/tool': true });
  assert.deepEqual(result['search.exclude'], { archive: true, project: false, 'packages/tool': true });
  assert.equal(updateExcludesSettings(updated, ['project', 'packages/tool'], { project: false, 'packages/tool': true }, true), updated);
});

test('Search exclusions stay untouched when only Explorer visibility is requested', () => {
  const source = '{ "search.exclude": { "project": true }, "files.exclude": {} }';
  const updated = updateExcludesSettings(source, ['project'], { project: false }, false);
  assert.deepEqual(parse(updated)['search.exclude'], { project: true });
  assert.deepEqual(parse(updated)['files.exclude'], { project: false });
});

test('Malformed settings, duplicate keys and missing visibility choices are refused', () => {
  for (const text of ['{', '[]', '{"files.exclude": true}', '{"files.exclude": {}, "files.exclude": {}}']) {
    assert.throws(() => updateExcludesSettings(text, ['project'], { project: true }, true));
  }
  assert.throws(() => updateExcludesSettings('{}', ['project'], {}, true), /Missing visibility/);
  assert.throws(() => updateExcludesSettings('{}', ['.'], { '.': true }, true), /entire workspace/);
});

test('An ordinary workspace root stays visible without creating a dot exclusion', () => {
  const source = '{ "editor.tabSize": 4, "files.exclude": { "**/.cache": true } }';
  assert.equal(updateExcludesSettings(source, ['.'], { '.': false }, true), source);
});
