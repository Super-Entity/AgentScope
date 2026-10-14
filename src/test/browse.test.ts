import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectProjectEntry, listProjectChildren } from '../browse';
import { directoryLink, fixture } from './helpers';

test('Browsing reads one directory at a time and never reads file contents', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  await fs.mkdir(path.join(moduleRoot, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(moduleRoot, '.git'));
  await fs.writeFile(path.join(moduleRoot, 'src', 'nested', 'deep.ts'), 'private content');
  await fs.writeFile(path.join(moduleRoot, 'README.md'), 'documentation');
  await fs.writeFile(path.join(moduleRoot, '.env'), 'private configuration');
  const realReaddir = fs.readdir.bind(fs);
  const listed: string[] = [];
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    listed.push(String(args[0]));
    return realReaddir(...args);
  });
  t.mock.method(fs, 'readFile', async () => {
    throw new Error('Browsing must not read any file contents');
  });
  const children = await listProjectChildren(root, 'project');
  assert.deepEqual(new Set(children.map(child => child.relative)), new Set(['src', 'README.md', '.env']));
  assert.equal(children.find(child => child.relative === 'src')!.directory, true);
  assert.equal(children.find(child => child.relative === 'README.md')!.directory, false);
  assert.equal(children.some(child => child.relative.includes('nested')), false);
  assert.deepEqual(listed, [moduleRoot]);
  const nested = await listProjectChildren(root, 'project', 'src');
  assert.deepEqual(nested.map(child => child.relative), ['src/nested']);
  assert.deepEqual(listed, [moduleRoot, path.join(moduleRoot, 'src')]);
});

test('Outside links are skipped and cannot be expanded explicitly', async (t) => {
  const { root, outside } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  await fs.mkdir(moduleRoot);
  await fs.writeFile(path.join(moduleRoot, 'safe.md'), 'safe');
  await fs.writeFile(path.join(outside, 'outside.md'), 'outside');
  await directoryLink(outside, path.join(moduleRoot, 'escape'));
  assert.deepEqual((await listProjectChildren(root, 'project')).map(child => child.relative), ['safe.md']);
  await assert.rejects(listProjectChildren(root, 'project', 'escape'), /symbolic link|junction|permitted root|outside/);
  await assert.rejects(listProjectChildren(root, 'project', '.', { strict: true }), /symbolic link|junction|permitted root|outside/);
});

test('Safe internal aliases are marked so inherited access splitting can refuse them', async (t) => {
  const { root } = await fixture(t);
  const actual = path.join(root, 'project', 'actual');
  await fs.mkdir(actual, { recursive: true });
  await directoryLink(actual, path.join(root, 'project', 'alias'));
  const children = await listProjectChildren(root, 'project');
  const alias = children.find(child => child.relative === 'alias');
  assert.equal(alias?.directory, true);
  assert.equal(alias?.symbolicLink, true);
  assert.equal(children.find(child => child.relative === 'actual')?.directory, true);
});

test('Canonical Git metadata aliases cannot be displayed, expanded or used as project roots', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project', '.git', 'objects'), { recursive: true });
  await directoryLink(path.join(root, 'project', '.git'), path.join(root, 'project', 'cache'));
  assert.deepEqual(await listProjectChildren(root, 'project'), []);
  await assert.rejects(listProjectChildren(root, 'project', 'cache'), /Git metadata/i);
  await assert.rejects(listProjectChildren(root, 'project', '.', { strict: true }), /Git metadata/i);
  await fs.mkdir(path.join(root, '.git'));
  await directoryLink(path.join(root, '.git'), path.join(root, 'linked-project'));
  await assert.rejects(listProjectChildren(root, 'linked-project'), /Git metadata/i);
});

test('Project browsing cannot traverse into sibling projects or an external module root', async (t) => {
  const { root, outside } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.mkdir(path.join(root, 'sibling'));
  await directoryLink(path.join(root, 'sibling'), path.join(root, 'project', 'sibling-link'));
  assert.deepEqual(await listProjectChildren(root, 'project'), []);
  await assert.rejects(listProjectChildren(root, 'project', '../sibling'), /parent|traverse/);
  await directoryLink(outside, path.join(root, 'external-project'));
  await assert.rejects(listProjectChildren(root, 'external-project'), /symbolic link|junction|permitted root|outside/);
});

test('An ordinary workspace root can be expanded without recursively discovering its children', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'docs', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'top.md'), 'top');
  const children = await listProjectChildren(root, '.');
  assert.deepEqual(new Set(children.map(child => child.relative)), new Set(['docs', 'top.md']));
  assert.equal(children.some(child => child.relative.startsWith('docs/')), false);
});

test('Missing directories, regular-file expansion and traversal are reported', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(root, 'project', 'file.md'), 'text');
  await assert.rejects(listProjectChildren(root, 'project', 'missing'));
  await assert.rejects(listProjectChildren(root, 'project', 'file.md'));
  await assert.rejects(listProjectChildren(root, '../outside'));
});


test('Project expansion resolves anchors once per operation and bounds concurrent child checks', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  await fs.mkdir(moduleRoot);
  await Promise.all(Array.from({ length: 48 }, (_, index) => fs.writeFile(path.join(moduleRoot, `file-${index}.md`), 'leaf')));
  const realpath = fs.realpath.bind(fs);
  const resolved: string[] = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    resolved.push(String(args[0]));
    active++; maximum = Math.max(maximum, active);
    try { await new Promise<void>(resolve => setImmediate(resolve)); return await realpath(...args); }
    finally { active--; }
  });
  assert.equal((await listProjectChildren(root, 'project')).length, 48);
  assert.ok(resolved.filter(target => target === root).length <= 3, 'The workspace anchor must not be resolved for every child');
  assert.ok(resolved.filter(target => target === moduleRoot).length <= 4, 'The project anchor must not be resolved for every child');
  assert.ok(maximum <= 32, `Child checks exceeded the filesystem concurrency limit: ${maximum}`);
});

test('Direct project entry validation checks current type and links without enumerating siblings', async (t) => {
  const { root, outside } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  await fs.mkdir(path.join(moduleRoot, '.git'), { recursive: true });
  await fs.writeFile(path.join(moduleRoot, 'leaf.md'), 'leaf');
  await directoryLink(outside, path.join(moduleRoot, 'escape'));
  await directoryLink(path.join(moduleRoot, '.git'), path.join(moduleRoot, 'metadata-alias'));
  t.mock.method(fs, 'readdir', async () => { throw new Error('A clicked entry must not enumerate its siblings'); });
  assert.deepEqual(await inspectProjectEntry(root, 'project', 'leaf.md'), { relative: 'leaf.md', directory: false });
  await fs.unlink(path.join(moduleRoot, 'leaf.md'));
  await fs.mkdir(path.join(moduleRoot, 'leaf.md'));
  assert.deepEqual(await inspectProjectEntry(root, 'project', 'leaf.md'), { relative: 'leaf.md', directory: true });
  await assert.rejects(inspectProjectEntry(root, 'project', 'missing.md'), /no longer exists.*refresh/i);
  await assert.rejects(inspectProjectEntry(root, 'project', 'escape'), /symbolic link|junction|permitted root/i);
  await assert.rejects(inspectProjectEntry(root, 'project', 'metadata-alias'), /Git metadata/i);
});

test('Replacing the project directory during expansion rejects results from the old operation anchor', async (t) => {
  const { root } = await fixture(t);
  const moduleRoot = path.join(root, 'project');
  await fs.mkdir(moduleRoot);
  await fs.writeFile(path.join(moduleRoot, 'leaf.md'), 'original');
  const readdir = fs.readdir.bind(fs);
  let replaced = false;
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await readdir(...args);
    if (String(args[0]) === moduleRoot && !replaced) {
      replaced = true;
      await fs.rename(moduleRoot, moduleRoot + '-old');
      await fs.mkdir(moduleRoot);
      await fs.writeFile(path.join(moduleRoot, 'leaf.md'), 'replacement');
    }
    return entries;
  });
  await assert.rejects(listProjectChildren(root, 'project'), /directory changed.*refresh/i);
  assert.equal(replaced, true);
});
