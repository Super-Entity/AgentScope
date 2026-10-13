import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ListingOptions, SelectionChild } from './core/selection';
import { normalizeRelative, resolveContained, verifyContained } from './core/paths';

const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const metadata = (relative: string): boolean => relative.split('/').some(segment => key(segment) === key('.git'));

/** Browse one immediate level; strict listings are used when replacing a broad access grant. */
export async function listProjectChildren(
  root: string, modulePath: string, relativeDir: string = '.', options: ListingOptions = {},
): Promise<SelectionChild[]> {
  const workspaceRoot = await fs.realpath(path.resolve(root));
  const projectRoot = resolveContained(workspaceRoot, modulePath);
  if (metadata(normalizeRelative(modulePath))) throw new Error('Git metadata cannot be used as a project-content root.');
  const canonicalProject = await verifyContained(workspaceRoot, projectRoot);
  if (metadata(normalizeRelative(path.relative(workspaceRoot, canonicalProject) || '.'))) {
    throw new Error('A project root enters Git metadata through a link.');
  }
  const relative = normalizeRelative(relativeDir);
  if (metadata(relative)) throw new Error('Git metadata is managed separately and cannot be browsed in the project tree.');
  const directory = resolveContained(projectRoot, relative);
  const canonicalDirectory = await verifyContained(projectRoot, directory);
  if (metadata(normalizeRelative(path.relative(workspaceRoot, canonicalDirectory) || '.'))) {
    throw new Error('A project folder enters Git metadata through a link.');
  }
  if (!(await fs.stat(canonicalDirectory)).isDirectory()) throw new Error(`The selected project path is not a folder: ${relative}`);
  const entries = await fs.readdir(canonicalDirectory, { withFileTypes: true });
  const listed = await Promise.all(entries.map(async entry => {
    if (key(entry.name) === key('.git')) return null;
    const literal = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    try {
      const childRelative = normalizeRelative(literal);
      const childPath = resolveContained(projectRoot, childRelative);
      const canonical = await verifyContained(projectRoot, childPath);
      await verifyContained(workspaceRoot, childPath);
      if (metadata(normalizeRelative(path.relative(workspaceRoot, canonical) || '.'))) {
        throw new Error('A project entry enters Git metadata through a link.');
      }
      const info = await fs.lstat(childPath);
      const symbolicLink = info.isSymbolicLink();
      const followed = symbolicLink ? await fs.stat(canonical) : info;
      if (!followed.isDirectory() && !followed.isFile()) throw new Error('The entry is not a regular file or directory.');
      return { relative: childRelative, directory: followed.isDirectory(), ...(symbolicLink ? { symbolicLink: true } : {}) };
    } catch (error) {
      if (options.strict) throw new Error(`Cannot safely list ${literal}: ${(error as Error).message}`);
      return null;
    }
  }));
  return listed.filter((entry): entry is SelectionChild => entry !== null).sort((first, second) => {
    if (first.directory !== second.directory) return first.directory ? -1 : 1;
    const left = key(first.relative);
    const right = key(second.relative);
    return left < right ? -1 : left > right ? 1 : first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0;
  });
}
