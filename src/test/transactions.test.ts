import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyPlan, restoreChanges } from '../transactions';
import { captureDirectoryIdentity } from '../core/paths';
import { directoryLink, fixture } from './helpers';

test('Apply and restore retain original contents and remove newly created files', async (t) => {
  const { root } = await fixture(t);
  const existing = path.join(root, 'AGENTS.md');
  const created = path.join(root, '.vscode', 'settings.json');
  await fs.writeFile(existing, 'original policy');
  const changes = await applyPlan({ warnings: [], changes: [
    { path: existing, before: 'original policy', after: 'updated policy' },
    { path: created, before: null, after: '{"files.exclude": {}}' },
  ] });
  assert.equal(await fs.readFile(existing, 'utf8'), 'updated policy');
  assert.equal(await fs.readFile(created, 'utf8'), '{"files.exclude": {}}');
  await restoreChanges(changes);
  assert.equal(await fs.readFile(existing, 'utf8'), 'original policy');
  await assert.rejects(fs.stat(created), { code: 'ENOENT' });
});

test('Apply preflights all expected contents before writing any file', async (t) => {
  const { root } = await fixture(t);
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  await fs.writeFile(one, 'first original');
  await fs.writeFile(two, 'external change');
  await assert.rejects(applyPlan({ warnings: [], changes: [
    { path: one, before: 'first original', after: 'first changed' },
    { path: two, before: 'stale original', after: 'second changed' },
  ] }), /changed.*refresh/i);
  assert.equal(await fs.readFile(one, 'utf8'), 'first original');
  assert.equal(await fs.readFile(two, 'utf8'), 'external change');
});

test('Restore refuses all changes if any applied file has a competing edit', async (t) => {
  const { root } = await fixture(t);
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  const changes = await applyPlan({ warnings: [], changes: [
    { path: one, before: null, after: 'first applied' },
    { path: two, before: null, after: 'second applied' },
  ] });
  await fs.writeFile(two, 'user edit');
  await assert.rejects(restoreChanges(changes), /changed.*refresh/i);
  assert.equal(await fs.readFile(one, 'utf8'), 'first applied');
  assert.equal(await fs.readFile(two, 'utf8'), 'user edit');
});

test('A failed second rename rolls back the first file and cleans staged temporary files', async (t) => {
  const { root } = await fixture(t);
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  await fs.writeFile(one, 'first original');
  await fs.writeFile(two, 'second original');
  const realRename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination) === two && !failed) {
      failed = true;
      throw new Error('Injected second-file rename failure');
    }
    await realRename(source, destination);
  });
  await assert.rejects(applyPlan({ warnings: [], changes: [
    { path: one, before: 'first original', after: 'first updated' },
    { path: two, before: 'second original', after: 'second updated' },
  ] }), /Injected second-file/);
  assert.equal(await fs.readFile(one, 'utf8'), 'first original');
  assert.equal(await fs.readFile(two, 'utf8'), 'second original');
  assert.deepEqual((await fs.readdir(root)).sort(), ['one', 'two']);
});

test('Rollback preserves a competing edit and reports the recovery failure', async (t) => {
  const { root } = await fixture(t);
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  await fs.writeFile(one, 'first original');
  await fs.writeFile(two, 'second original');
  const realRename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination) === two && !failed) {
      failed = true;
      await fs.writeFile(one, 'competing edit');
      throw new Error('Injected second-file failure with competing edit');
    }
    await realRename(source, destination);
  });
  await assert.rejects(applyPlan({ warnings: [], changes: [
    { path: one, before: 'first original', after: 'first updated' },
    { path: two, before: 'second original', after: 'second updated' },
  ] }), /could not be rolled back without overwriting competing edits/);
  assert.equal(await fs.readFile(one, 'utf8'), 'competing edit');
  assert.equal(await fs.readFile(two, 'utf8'), 'second original');
  assert.deepEqual((await fs.readdir(root)).sort(), ['one', 'two']);
});

test('A linked configuration parent cannot redirect a planned write', async (t) => {
  const { root, outside } = await fixture(t);
  await directoryLink(outside, path.join(root, '.vscode'));
  await assert.rejects(applyPlan({ warnings: [], changes: [
    { path: path.join(root, '.vscode', 'settings.json'), before: null, after: '{}' },
  ] }), /parent.*symbolic link|symbolic.*parent/i);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Duplicate transaction targets are refused before changes', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'AGENTS.md');
  const entry = { path: target, before: null, after: 'new' };
  await assert.rejects(applyPlan({ changes: [entry, entry], warnings: [] }), /Duplicate configuration/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('A root replaced after temporary staging is rejected before publishing configuration', async (t) => {
  const { root } = await fixture(t);
  const identity = await captureDirectoryIdentity(root);
  const realOpen = fs.open.bind(fs);
  let swapped = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).includes('.agentscope-') && !swapped) {
      const realClose = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await realClose();
        if (!swapped) {
          swapped = true;
          await fs.rename(root, root + '-original');
          await fs.mkdir(root);
        }
      });
    }
    return handle;
  });
  await assert.rejects(applyPlan({ warnings: [], changes: [
    { path: path.join(root, 'AGENTS.md'), before: null, after: 'The old draft must not be published.' },
  ], directoryChecks: [{ path: root, identity }] }), /root directory changed.*refresh/i);
  assert.equal(swapped, true);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(fs.stat(path.join(root + '-original', 'AGENTS.md')), { code: 'ENOENT' });
});
