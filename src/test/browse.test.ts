import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { listProjectChildren } from '../browse';
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
