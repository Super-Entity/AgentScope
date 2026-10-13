import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertDirectoryIdentity, verifyContained } from './core/paths';
import { ApplyPlan, FileChange } from './types';

interface WriteOperation { path: string; expected: string | null; replacement: string | null }
interface StagedWrite extends WriteOperation { temporary?: string; mode?: number }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Plans contain canonical paths. Refuse a directory link swapped in after planning. */
async function assertStablePath(target: string): Promise<void> {
  if (!path.isAbsolute(target)) throw new Error(`Expected an absolute configuration path: ${target}`);
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing a symbolic-link configuration target: ${target}`);
    if (!info.isFile()) throw new Error(`Configuration target is not a regular file: ${target}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let parent = path.dirname(target);
  for (;;) {
    try {
      const canonical = await fs.realpath(parent);
      if (!samePath(canonical, parent)) {
        throw new Error(`Configuration parent changed or is a symbolic link: ${parent}`);
      }
      const info = await fs.stat(parent);
      if (!info.isDirectory()) throw new Error(`Configuration parent is not a directory: ${parent}`);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw new Error(`Configuration parent is missing: ${target}`);
      parent = next;
    }
  }
}

async function readCurrent(target: string): Promise<string | null> {
  await assertStablePath(target);
  try { return await fs.readFile(target, 'utf8'); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

async function assertExpected(operation: WriteOperation): Promise<void> {
  if (await readCurrent(operation.path) !== operation.expected) {
    throw new Error(`Configuration changed since it was read; refresh before applying: ${operation.path}`);
  }
}

async function ensureParent(target: string, created: Set<string>): Promise<void> {
  const missing: string[] = [];
  let candidate = path.dirname(target);
  for (;;) {
    try { await fs.lstat(candidate); break; }
    catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(candidate);
      const next = path.dirname(candidate);
      if (next === candidate) throw error;
      candidate = next;
    }
  }
  for (const directory of missing.reverse()) {
    try { await fs.mkdir(directory); created.add(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  await assertStablePath(target);
}

async function stage(operation: WriteOperation, directories: Set<string>): Promise<StagedWrite> {
  await assertExpected(operation);
  if (operation.replacement === null) return { ...operation };
  let mode = 0o600;
  if (operation.expected !== null) mode = (await fs.stat(operation.path)).mode & 0o777;
  await ensureParent(operation.path, directories);
  const temporary = path.join(path.dirname(operation.path), `.${path.basename(operation.path)}.agentscope-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(operation.replacement, 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { ...operation, temporary, mode };
}

async function commit(staged: StagedWrite, beforePublish?: () => void | Promise<void>): Promise<void> {
  await assertExpected(staged);
  await beforePublish?.();
  if (staged.replacement === null) {
    if (staged.expected !== null) await fs.unlink(staged.path);
  } else {
    // Same-directory rename replaces the destination atomically on supported local filesystems,
    // including Windows. Never unlink the old target to work around a failed rename.
    await fs.rename(staged.temporary!, staged.path);
    staged.temporary = undefined;
  }
}

async function cleanTemporary(staged: StagedWrite[]): Promise<void> {
  await Promise.all(staged.map(async (item) => {
    if (item.temporary) await fs.unlink(item.temporary).catch(() => undefined);
  }));
}

async function cleanDirectories(directories: Set<string>): Promise<void> {
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(directory).catch(() => undefined);
  }
}

function validateOperations(operations: WriteOperation[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (!path.isAbsolute(operation.path)) throw new Error(`Expected an absolute configuration path: ${operation.path}`);
    const key = process.platform === 'win32' ? path.resolve(operation.path).toLowerCase() : path.resolve(operation.path);
    if (seen.has(key)) throw new Error(`Duplicate configuration target: ${operation.path}`);
    seen.add(key);
    for (const value of [operation.expected, operation.replacement]) {
      if (value !== null && typeof value !== 'string') throw new Error(`Invalid configuration contents: ${operation.path}`);
    }
  }
}

async function execute(operations: WriteOperation[], guard?: () => Promise<void>, beforePublish?: () => void | Promise<void>): Promise<void> {
  validateOperations(operations);
  if (guard) await guard();
  // Preflight every file before creating a directory or changing a configuration file.
  for (const operation of operations) await assertExpected(operation);
  const directories = new Set<string>();
  const staged: StagedWrite[] = [];
  const applied: StagedWrite[] = [];
  try {
    for (const operation of operations) staged.push(await stage(operation, directories));
    // Recheck inputs and project junctions after staging, before the first configuration write.
    if (guard) await guard();
    for (const item of staged) { await commit(item, beforePublish); applied.push(item); }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of [...applied].reverse()) {
      let rollback: StagedWrite | undefined;
      try {
        rollback = await stage({ path: item.path, expected: item.replacement, replacement: item.expected }, directories);
        await commit(rollback);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.path}: ${(rollbackError as Error).message}`);
      } finally {
        if (rollback) await cleanTemporary([rollback]);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${(error as Error).message}\nSome changes could not be rolled back without overwriting competing edits:\n${rollbackErrors.join('\n')}`);
    }
    throw error;
  } finally {
    await cleanTemporary(staged);
    await cleanDirectories(directories);
  }
}

export async function applyPlan(plan: ApplyPlan, beforePublish?: () => void | Promise<void>): Promise<FileChange[]> {
  const guard = async (): Promise<void> => {
    for (const check of plan.directoryChecks ?? []) await assertDirectoryIdentity(check.path, check.identity);
    for (const check of plan.checks ?? []) {
      if (check.expected !== null && typeof check.expected !== 'string') throw new Error(`Invalid expected input contents: ${check.path}`);
      if (await readCurrent(check.path) !== check.expected) {
        throw new Error(`Workspace input changed since it was read; refresh before applying: ${check.path}`);
      }
    }
    for (const check of plan.pathChecks ?? []) {
      if (![check.root, check.path, check.resolved].every(value => typeof value === 'string' && path.isAbsolute(value))) {
        throw new Error('Scope containment checks require absolute paths.');
      }
      const resolved = await verifyContained(check.root, check.path);
      if (!samePath(resolved, check.resolved)) throw new Error(`A project scope changed through a link; refresh before applying: ${check.path}`);
    }
  };
  await execute(plan.changes.map((change) => ({ path: change.path, expected: change.before, replacement: change.after })), async () => {
    await guard();
    await beforePublish?.();
  }, beforePublish);
  return plan.changes.map((change) => ({ ...change }));
}

/** Undo only this transaction, and only while every applied file still has our contents. */
export async function restoreChanges(changes: FileChange[], beforePublish?: () => void | Promise<void>): Promise<void> {
  await execute(changes.map((change) => ({ path: change.path, expected: change.after, replacement: change.before })),
    beforePublish ? async () => { await beforePublish(); } : undefined, beforePublish);
}
