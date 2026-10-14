import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedState, selectionReader, togglePathSelection } from '../core/selection';
import { project } from './helpers';

interface Child { relative: string; directory: boolean; symbolicLink?: boolean }

test('Batch selection readers retain precise read/write state for one draft snapshot', () => {
  for (const module of [
    project({ read_paths: ['src/a.ts', 'src/a.ts', 'docs'], write_paths: ['src/nested', 'drafts'] }),
    project({ restrict_paths: false }),
    project({ enabled: false }),
  ]) {
    const read = selectionReader(module);
    for (const relative of ['.', 'src', 'src/a.ts', 'src/nested/a.ts', 'docs', 'drafts/new.md', 'other.md']) {
      assert.deepEqual(read(relative), { read: selectedState(module, relative, 'read'), write: selectedState(module, relative, 'write') });
    }
    assert.throws(() => read('../outside'));
    assert.throws(() => read('.git/config'));
  }
  const module = project({ write_paths: ['src'] });
  const snapshot = selectionReader(module);
  module.write_paths = ['docs'];
  assert.equal(snapshot('src').write.checked, true);
  assert.equal(selectionReader(module)('src').write.checked, false);
});

function tree() {
  const directories: Record<string, Child[]> = {
    '.': [{ relative: 'src', directory: true }, { relative: 'README.md', directory: false }, { relative: 'docs', directory: true }],
    src: [{ relative: 'src/index.ts', directory: false }, { relative: 'src/util.ts', directory: false }, { relative: 'src/nested', directory: true }],
    'src/nested': [{ relative: 'src/nested/a.ts', directory: false }, { relative: 'src/nested/b.ts', directory: false }],
    docs: [{ relative: 'docs/guide.md', directory: false }],
  };
  const calls: string[] = [];
  return {
    calls,
    list: async (relative: string): Promise<Child[]> => {
      calls.push(relative);
      assert.ok(Object.hasOwn(directories, relative), `Unexpected directory enumeration: ${relative}`);
      return directories[relative].map(child => ({ ...child }));
    },
  };
}

test('Selecting one file in a disabled formerly full project resets broad access', async () => {
  const value = project({ enabled: false, restrict_paths: false, read_paths: ['docs'], write_paths: ['.'] });
  const original = structuredClone(value);
  const directory = tree();
  const selected = await togglePathSelection(value, 'src/index.ts', 'read', true, directory.list);
  assert.deepEqual(value, original);
  assert.equal(selected.enabled, true);
  assert.equal(selected.restrict_paths, true);
  assert.deepEqual(selected.read_paths, ['src/index.ts']);
  assert.deepEqual(selected.write_paths, []);
  assert.equal(selectedState(selected, 'src/index.ts', 'read').checked, true);
  assert.equal(selectedState(selected, 'src/util.ts', 'read').checked, false);
  assert.equal(selectedState(selected, 'src/index.ts', 'write').checked, false);
  assert.deepEqual(directory.calls, ['src']);
});

test('Selecting a writable file makes it readable without granting its siblings', async () => {
  const directory = tree();
  const selected = await togglePathSelection(project({ enabled: false }), 'src/index.ts', 'write', true, directory.list);
  assert.deepEqual(selected.read_paths, []);
  assert.deepEqual(selected.write_paths, ['src/index.ts']);
  assert.deepEqual(selectedState(selected, 'src/index.ts', 'write'), { checked: true, partial: false, inherited: false });
  assert.equal(selectedState(selected, 'src/index.ts', 'read').checked, true);
  assert.equal(selectedState(selected, 'src/util.ts', 'read').checked, false);
  assert.deepEqual(directory.calls, ['src']);
});

test('Directory states show partial selections and effective inheritance from writable parents', () => {
  const value = project({ read_paths: ['src/index.ts'], write_paths: ['docs'] });
  assert.deepEqual(selectedState(value, 'src', 'read'), { checked: false, partial: true, inherited: false });
  assert.deepEqual(selectedState(value, 'src', 'write'), { checked: false, partial: false, inherited: false });
  assert.deepEqual(selectedState(value, 'docs/guide.md', 'write'), { checked: true, partial: false, inherited: true });
  assert.equal(selectedState(value, 'docs/guide.md', 'read').checked, true);
  value.enabled = false;
  assert.deepEqual(selectedState(value, 'src', 'read'), { checked: false, partial: false, inherited: false });
  assert.deepEqual(selectedState(value, 'docs/guide.md', 'write'), { checked: false, partial: false, inherited: false });
});

test('Unchecking a writable child under a selected parent preserves sibling permissions', async () => {
  const value = project({ read_paths: [], write_paths: ['src'] });
  const original = structuredClone(value);
  const directory = tree();
  const selected = await togglePathSelection(value, 'src/index.ts', 'write', false, directory.list);
  assert.deepEqual(value, original);
  assert.equal(selectedState(selected, 'src/index.ts', 'write').checked, false);
  assert.equal(selectedState(selected, 'src/util.ts', 'write').checked, true);
  assert.equal(selectedState(selected, 'src/nested/a.ts', 'write').checked, true);
  assert.equal(selectedState(selected, 'src', 'write').partial, true);
  assert.equal(selected.write_paths.includes('src'), false);
  assert.equal(selected.write_paths.includes('.'), false);
  assert.deepEqual(directory.calls, ['src']);
});

test('Unchecking read access also removes effective write access while retaining other paths', async () => {
  const value = project({ read_paths: ['src'], write_paths: ['src/index.ts', 'docs'] });
  const directory = tree();
  const selected = await togglePathSelection(value, 'src/index.ts', 'read', false, directory.list);
  assert.equal(selectedState(selected, 'src/index.ts', 'read').checked, false);
  assert.equal(selectedState(selected, 'src/index.ts', 'write').checked, false);
  assert.equal(selectedState(selected, 'src/util.ts', 'read').checked, true);
  assert.equal(selectedState(selected, 'docs/guide.md', 'write').checked, true);
  assert.equal(selected.read_paths.includes('src'), false);
  assert.deepEqual(directory.calls, ['src']);
});

test('Removing write access retains a separately selected readable parent', async () => {
  const value = project({ read_paths: ['src'], write_paths: ['src'] });
  const directory = tree();
  const selected = await togglePathSelection(value, 'src/index.ts', 'write', false, directory.list);
  assert.equal(selectedState(selected, 'src/index.ts', 'write').checked, false);
  assert.equal(selectedState(selected, 'src/index.ts', 'read').checked, true);
  assert.equal(selectedState(selected, 'src/util.ts', 'write').checked, true);
  assert.deepEqual(selected.read_paths, ['src']);
});

test('Removing one deeply inherited file splits only the ancestors on its path', async () => {
  const value = project({ restrict_paths: false, read_paths: [], write_paths: [] });
  const directory = tree();
  const selected = await togglePathSelection(value, 'src/nested/a.ts', 'read', false, directory.list);
  assert.equal(selected.restrict_paths, true);
  assert.equal(selectedState(selected, 'src/nested/a.ts', 'read').checked, false);
  assert.equal(selectedState(selected, 'src/nested/a.ts', 'write').checked, false);
  assert.equal(selectedState(selected, 'src/nested/b.ts', 'write').checked, true);
  assert.equal(selectedState(selected, 'src/index.ts', 'write').checked, true);
  assert.equal(selectedState(selected, 'docs/guide.md', 'write').checked, true);
  assert.equal(selectedState(selected, 'README.md', 'write').checked, true);
  assert.equal(selected.write_paths.includes('.'), false);
  assert.equal(selected.write_paths.includes('src'), false);
  assert.equal(selected.write_paths.includes('src/nested'), false);
  assert.deepEqual(directory.calls, ['.', 'src', 'src/nested']);
});

test('Selecting a parent validates one level and removes redundant descendants', async () => {
  const value = project({ read_paths: ['src/index.ts', 'src/nested/a.ts', 'docs'], write_paths: [] });
  const directory = tree();
  const selected = await togglePathSelection(value, 'src', 'read', true, directory.list);
  assert.deepEqual(new Set(selected.read_paths), new Set(['src', 'docs']));
  assert.deepEqual(selected.write_paths, []);
  assert.deepEqual(directory.calls, ['.']);
});

test('Path boundary matching does not confuse similarly named sibling folders', () => {
  const value = project({ read_paths: ['src'], write_paths: [] });
  assert.equal(selectedState(value, 'src-old/file.ts', 'read').checked, false);
  assert.equal(selectedState(value, 'src-old', 'read').partial, false);
  assert.equal(selectedState(value, 'src/file.ts', 'read').checked, true);
});

test('Failed directory expansion does not alter the input access registry', async () => {
  const value = project({ read_paths: [], write_paths: ['.'] });
  const original = structuredClone(value);
  await assert.rejects(togglePathSelection(value, 'src/index.ts', 'write', false, async () => {
    throw new Error('Directory cannot be listed');
  }), /Directory cannot be listed/);
  assert.deepEqual(value, original);
});

test('Traversal paths are rejected before changing or enumerating access choices', async () => {
  const value = project();
  const original = structuredClone(value);
  const directory = tree();
  await assert.rejects(togglePathSelection(value, '../outside/file.md', 'read', true, directory.list), /parent|traverse/);
  assert.deepEqual(value, original);
  assert.deepEqual(directory.calls, []);
});

test('Selecting a missing child cannot enable or broaden a disabled project', async () => {
  const value = project({ enabled: false, restrict_paths: false, read_paths: ['docs'], write_paths: ['.'] });
  const original = structuredClone(value);
  const directory = tree();
  await assert.rejects(togglePathSelection(value, 'src/missing.ts', 'write', true, directory.list), /missing|exist|found|no longer/i);
  assert.deepEqual(value, original);
  assert.deepEqual(directory.calls, ['src']);
});

test('Inherited access splitting refuses sibling aliases and preserves the original scope', async () => {
  const value = project({ read_paths: [], write_paths: ['src'] });
  const original = structuredClone(value);
  await assert.rejects(togglePathSelection(value, 'src/index.ts', 'write', false, async () => [
    { relative: 'src/index.ts', directory: false },
    { relative: 'src/alias', directory: true, symbolicLink: true },
  ]), /symbolic|link|alias/i);
  assert.deepEqual(value, original);
});

test('An invalid non-immediate child listing cannot replace an inherited grant', async () => {
  const value = project({ read_paths: [], write_paths: ['src'] });
  const original = structuredClone(value);
  await assert.rejects(togglePathSelection(value, 'src/index.ts', 'write', false, async () => [
    { relative: 'src/index.ts', directory: false },
    { relative: 'outside/file.ts', directory: false },
  ]), /immediate children/);
  assert.deepEqual(value, original);
});
