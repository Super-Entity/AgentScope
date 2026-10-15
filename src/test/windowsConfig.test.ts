import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as TOML from '@iarna/toml';
import { updateWindowsSandbox } from '../core/windowsConfig';

test('Windows sandbox updates preserve whitespace, comments, other tables and CRLF bytes', () => {
  const original = 'model = "codex"\r\n\r\n[windows] # backend\r\n  sandbox  = \'elevated\'  # keep this\r\nprivate_desktop = true\r\n\r\n[other]\r\nsandbox = "other"\r\n';
  const updated = updateWindowsSandbox(original, 'mxc');
  assert.equal(updated, original.replace("'elevated'", '"mxc"'));
  assert.equal(updateWindowsSandbox(updated, 'mxc'), updated, 'Already selected backend is a byte-preserving no-op');
});

test('Root dotted sandbox keys update in place and retain their owning table', () => {
  const original = 'windows . sandbox = "mxc" # selection\nwindows.other = "keep"\n[app]\nsandbox = "app"';
  assert.equal(updateWindowsSandbox(original, 'elevated'), original.replace('"mxc"', '"elevated"'));
});

test('An absent Windows table is appended without changing existing values or comments', () => {
  for (const original of ['', '# config', 'model = "codex"\n', '[other]\nvalue = true\n\n']) {
    const updated = updateWindowsSandbox(original, 'mxc');
    assert.ok(updated.startsWith(original));
    assert.ok(updated.endsWith('[windows]\nsandbox = "mxc"\n'));
    assert.deepEqual(TOML.parse(updated), { ...TOML.parse(original), windows: { sandbox: 'mxc' } });
  }
});

test('Existing Windows tables receive a key without moving their assignments', () => {
  for (const original of ['[windows]', '[windows] # keep\nprivate_desktop = false\n[app]\nvalue = true\n']) {
    const updated = updateWindowsSandbox(original, 'mxc');
    assert.equal((TOML.parse(updated).windows as Record<string, unknown>).sandbox, 'mxc');
    assert.equal(updated.replace(/sandbox = "mxc"\n/, '').trimEnd(), original.trimEnd());
  }
});

test('A Windows child table permits a later explicit parent table', () => {
  const original = '[windows.other]\nvalue = "preserve"\n';
  const updated = updateWindowsSandbox(original, 'mxc');
  assert.equal(updated, original + '\n[windows]\nsandbox = "mxc"\n');
  assert.deepEqual(TOML.parse(updated), { windows: { other: { value: 'preserve' }, sandbox: 'mxc' } });
});

test('Multiline strings, arrays and comments cannot masquerade as sandbox keys or Windows tables', () => {
  const original = [
    '# [windows]',
    '# sandbox = "elevated"',
    'notes = """',
    '[windows]',
    'sandbox = "elevated"',
    '"""',
    "literal = '''",
    'windows.sandbox = "elevated"',
    "'''",
    'values = [',
    '  "[windows]", # sandbox = "elevated"',
    '  "sandbox = \\"elevated\\"",',
    ']',
    '[windows]',
    'sandbox = "elevated" # actual',
    '',
  ].join('\n');
  const updated = updateWindowsSandbox(original, 'mxc');
  assert.equal(updated, original.replace('sandbox = "elevated" # actual', 'sandbox = "mxc" # actual'));
});

test('Sandbox-looking text in another table never receives the Windows update', () => {
  const original = '[app]\nsandbox = "elevated"\nwindows.sandbox = "elevated"\n';
  const updated = updateWindowsSandbox(original, 'mxc');
  assert.ok(updated.startsWith(original));
  assert.deepEqual(TOML.parse(updated), { app: { sandbox: 'elevated', windows: { sandbox: 'elevated' } }, windows: { sandbox: 'mxc' } });
});

test('Unsupported layouts fail rather than changing unrelated data or rewriting user content', () => {
  for (const original of [
    'windows = { sandbox = "elevated", other = true }\n',
    '["windows"]\nsandbox = "elevated"\n',
    '[windows]\nsandbox = """elevated"""\n',
    '[windows]\nsandbox = true\n',
    'windows = {}\n',
    'windows.other = true\n',
  ]) {
    assert.throws(() => updateWindowsSandbox(original, 'mxc'), /safely|layout/);
  }
  for (const original of ['windows = "not a table"', '[[windows]]\nvalue = true']) {
    assert.throws(() => updateWindowsSandbox(original, 'mxc'), /must be a TOML table/);
  }
});

test('Malformed TOML and unknown backends fail before producing configuration', () => {
  assert.throws(() => updateWindowsSandbox('[windows\nsandbox = "elevated"', 'mxc'), /invalid TOML/);
  assert.throws(() => updateWindowsSandbox('', 'unelevated' as 'mxc'), /mxc or elevated/);
});
