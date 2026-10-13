import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DirectoryIdentity } from '../types';

/** Capture identity without treating ordinary additions/removals of children as replacement. */
export async function captureDirectoryIdentity(target: string): Promise<DirectoryIdentity> {
  if (!path.isAbsolute(target)) throw new Error('Directory identity checks require an absolute path.');
  const info = await fs.lstat(target, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`The workspace root must remain an ordinary directory: ${target}`);
  return { dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}

export async function assertDirectoryIdentity(target: string, expected: DirectoryIdentity): Promise<void> {
  if (!expected || !['dev', 'ino', 'birthtimeNs'].every(key => typeof expected[key as keyof DirectoryIdentity] === 'string' && /^\d+$/.test(expected[key as keyof DirectoryIdentity]))) {
    throw new Error('Invalid expected workspace directory identity.');
  }
  let actual: DirectoryIdentity;
  try { actual = await captureDirectoryIdentity(target); }
  catch (error) { throw new Error(`Workspace root directory changed since it was loaded; refresh before applying: ${target} (${(error as Error).message})`); }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) {
    throw new Error(`Workspace root directory changed since it was loaded; refresh before applying: ${target}`);
  }
}

/** Paths are literal workspace-relative paths, never globs or shell expressions. */
export function normalizeRelative(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('A path must be a non-empty literal relative path without surrounding whitespace or control characters.');
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Absolute paths are not allowed in scope settings: ${value}`);
  }
  if (/[*?\[\]{}:]/.test(value)) {
    throw new Error(`Use a literal path, without wildcard patterns or drive syntax: ${value}`);
  }
  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) { throw new Error(`A scope path cannot traverse a parent directory: ${value}`); }
  if (segments.some(segment => segment !== '.' && (/[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)))) {
    throw new Error(`A scope path must not use Windows device names or trailing dots/spaces: ${value}`);
  }
  return segments.filter(segment => segment !== '' && segment !== '.').join('/') || '.';
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function resolveContained(root: string, relative: string): string {
  const base = path.resolve(root);
  const normalized = normalizeRelative(relative);
  const target = path.resolve(base, ...normalized.split('/'));
  if (!isContained(base, target)) { throw new Error(`The path leaves its permitted root: ${relative}`); }
  return target;
}

/** Resolve a new file through its nearest existing parent, including junctions. */
async function realpathWithMissingTail(target: string): Promise<string> {
  let ancestor = target;
  const tail: string[] = [];
  for (;;) {
    try {
      // lstat separates a broken link from a nonexistent path; a broken link is unsafe.
      await fs.lstat(ancestor);
      return path.resolve(await fs.realpath(ancestor), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') { throw error; }
      try {
        const link = await fs.lstat(ancestor);
        if (link.isSymbolicLink()) { throw new Error(`Cannot resolve a broken symbolic link: ${ancestor}`); }
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') { throw linkError; }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) { throw new Error(`No existing parent can be resolved for: ${target}`); }
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function verifyContained(root: string, target: string): Promise<string> {
  const base = path.resolve(root);
  const candidate = path.resolve(base, target);
  if (!isContained(base, candidate)) { throw new Error(`The path is outside its permitted root: ${target}`); }
  const [realBase, realCandidate] = await Promise.all([realpathWithMissingTail(base), realpathWithMissingTail(candidate)]);
  if (!isContained(realBase, realCandidate)) {
    throw new Error(`A symbolic link or junction leaves its permitted root: ${target}`);
  }
  return realCandidate;
}
