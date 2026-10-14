import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { assertDirectoryIdentity, captureDirectoryIdentity, createContainedResolver, normalizeRelative, resolveContained, verifyContained } from '../core/paths';
import { directoryLink, fixture } from './helpers';

test('Literal relative paths normalize separators while rejecting traversal and patterns', () => {
  assert.equal(normalizeRelative('a\\b/./c/'), 'a/b/c');
  assert.equal(normalizeRelative('.'), '.');
  assert.equal(normalizeRelative('draft with spaces/file.md'), 'draft with spaces/file.md');
  for (const input of ['', ' ../secret', '../secret', 'a/../b', '/root', 'C:relative', 'C:\\root', '\\\\server\\share', '**/drafts', 'a?[b]', 'a\u0000b']) {
    assert.throws(() => normalizeRelative(input), input);
  }
});

test('Containment resolves new files from their nearest existing parent', async (t) => {
  const { root } = await fixture(t);
  const target = resolveContained(root, 'new/drafts/paper.md');
  assert.equal(await verifyContained(root, target), path.join(root, 'new', 'drafts', 'paper.md'));
  assert.equal(await verifyContained(root, root), root);
  await assert.rejects(verifyContained(root, path.join(root, '..', 'outside')), /outside|permitted root/);
});

test('A directory symlink or Windows junction cannot expose an outside target', async (t) => {
  const { root, outside } = await fixture(t);
  const link = path.join(root, 'escape');
  await directoryLink(outside, link);
  await assert.rejects(verifyContained(root, path.join(link, 'future', 'paper.md')), /symbolic link|junction/);
});

test('A link within the same permitted tree resolves to its canonical target', async (t) => {
  const { root } = await fixture(t);
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  await directoryLink(actual, path.join(root, 'alias'));
  assert.equal(await verifyContained(root, path.join(root, 'alias', 'new.md')), path.join(actual, 'new.md'));
});

test('Directory identity ignores ordinary child additions but detects an ordinary root replacement', async (t) => {
  const { root } = await fixture(t);
  const original = await captureDirectoryIdentity(root);
  assert.ok(Object.values(original).every(value => /^\d+$/.test(value)));
  await fs.writeFile(path.join(root, 'new-child.md'), 'A legitimate edit.');
  await fs.mkdir(path.join(root, 'new-child-directory'));
  await assertDirectoryIdentity(root, original);
  await fs.rename(root, root + '-original');
  await fs.mkdir(root);
  assert.notDeepEqual(await captureDirectoryIdentity(root), original);
  await assert.rejects(assertDirectoryIdentity(root, original), /root directory changed.*refresh/i);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Directory identity refuses links, non-directories and malformed expected tokens', async (t) => {
  const { root, outside } = await fixture(t);
  const link = path.join(root, 'alias');
  await directoryLink(outside, link);
  await assert.rejects(captureDirectoryIdentity(link), /ordinary directory/i);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'content');
  await assert.rejects(captureDirectoryIdentity(file), /ordinary directory/i);
  await assert.rejects(captureDirectoryIdentity('relative'), /absolute path/i);
  await assert.rejects(assertDirectoryIdentity(root, { dev: '0', ino: '1', birthtimeNs: '-1' }), /Invalid expected/i);
});

test('One operation reuses its root for missing descendants and rechecks it before returning', async (t) => {
  const { root } = await fixture(t);
  const realpath = fs.realpath.bind(fs);
  let rootResolutions = 0;
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    if (String(args[0]) === root) rootResolutions++;
    return realpath(...args);
  });
  const resolver = await createContainedResolver(root);
  for (const relative of ['new/a.md', 'new/b.md', 'another/c.md']) {
    assert.equal(await resolver.resolve(path.join(root, relative)), path.join(root, relative));
  }
  await resolver.assertUnchanged();
  assert.equal(rootResolutions, 2, 'Resolving more missing files must not repeat root resolution');
  await assert.rejects(resolver.resolve(path.join(root, '..', 'outside')), /outside/);
});

test('An operation never reuses a target link resolution after the link changes', async (t) => {
  const { root, outside } = await fixture(t);
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  const alias = path.join(root, 'alias');
  await directoryLink(actual, alias);
  const resolver = await createContainedResolver(root);
  assert.equal(await resolver.resolve(path.join(alias, 'future.md')), path.join(actual, 'future.md'));
  await fs.unlink(alias);
  await directoryLink(outside, alias);
  await assert.rejects(resolver.resolve(path.join(alias, 'future.md')), /symbolic link|junction/);
  await resolver.assertUnchanged();
});

test('An operation refuses a replaced ordinary root and a retargeted root alias', async (t) => {
  const { root, outside } = await fixture(t);
  const resolver = await createContainedResolver(root);
  await fs.rename(root, root + '-original');
  await fs.mkdir(root);
  await assert.rejects(resolver.assertUnchanged(), /root directory changed/i);
  const alias = path.join(root, 'alias');
  await directoryLink(root + '-original', alias);
  const linked = await createContainedResolver(alias);
  await fs.unlink(alias);
  await directoryLink(outside, alias);
  await assert.rejects(linked.assertUnchanged(), /directory changed through/i);
});

test('Existing-entry resolution keeps link containment and rejects missing entries without speculative targets', async (t) => {
  const { root, outside } = await fixture(t);
  const file = path.join(root, 'file.md');
  await fs.writeFile(file, 'selected');
  await directoryLink(outside, path.join(root, 'escape'));
  const resolver = await createContainedResolver(root);
  assert.equal(await resolver.resolveExisting(file), file);
  await assert.rejects(resolver.resolveExisting(path.join(root, 'missing.md')), { code: 'ENOENT' });
  await assert.rejects(resolver.resolveExisting(path.join(root, 'escape')), /symbolic link|junction/);
  await resolver.assertUnchanged();
});
