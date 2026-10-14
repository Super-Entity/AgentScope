import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ListingOptions, SelectionChild } from './core/selection';
import { ContainedResolver, createContainedResolver, normalizeRelative, resolveContained } from './core/paths';
import { mapConcurrent } from './core/concurrency';

const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const metadata = (relative: string): boolean => relative.split('/').some(segment => key(segment) === key('.git'));

interface ProjectContext { workspace: ContainedResolver; project: ContainedResolver }

async function context(root: string, modulePath: string): Promise<ProjectContext> {
  const relative = normalizeRelative(modulePath);
  if (metadata(relative)) throw new Error('Git metadata cannot be used as a project-content root.');
  const workspace = await createContainedResolver(root);
  const projectRoot = resolveContained(workspace.root, relative);
  const canonicalProject = await workspace.resolve(projectRoot);
  if (metadata(normalizeRelative(path.relative(workspace.canonicalRoot, canonicalProject) || '.'))) {
    throw new Error('A project root enters Git metadata through a link.');
  }
  const project = relative === '.' ? workspace : await createContainedResolver(projectRoot);
  if (project.canonicalRoot !== canonicalProject) throw new Error('The project root changed while opening it. Refresh and try again.');
  return { workspace, project };
}

function checkCanonical(state: ProjectContext, canonical: string): void {
  // The project resolver already checked the narrower project boundary. Verify
  // the workspace boundary and metadata using that same fresh resolved target.
  const relative = normalizeRelative(path.relative(state.workspace.canonicalRoot, canonical) || '.');
  if (metadata(relative)) throw new Error('A project entry enters Git metadata through a link.');
}

async function assertUnchanged(state: ProjectContext): Promise<void> {
  await Promise.all(state.project === state.workspace ? [state.workspace.assertUnchanged()]
    : [state.workspace.assertUnchanged(), state.project.assertUnchanged()]);
}

async function inspect(state: ProjectContext, literal: string): Promise<SelectionChild> {
  const relative = normalizeRelative(literal);
  if (metadata(relative)) throw new Error('Git metadata is managed separately and cannot be browsed in the project tree.');
  const childPath = resolveContained(state.project.root, relative);
  const canonical = await state.project.resolveExisting(childPath);
  checkCanonical(state, canonical);
  // A current lstat preserves type changes and link flags after readdir.
  const info = await fs.lstat(childPath);
  const symbolicLink = info.isSymbolicLink();
  const followed = symbolicLink ? await fs.stat(canonical) : info;
  if (!followed.isDirectory() && !followed.isFile()) throw new Error('The entry is not a regular file or directory.');
  return { relative, directory: followed.isDirectory(), ...(symbolicLink ? { symbolicLink: true } : {}) };
}

/** Validate only a clicked entry; checkbox grants do not require enumerating its siblings. */
export async function inspectProjectEntry(root: string, modulePath: string, relative: string): Promise<SelectionChild> {
  const state = await context(root, modulePath);
  let entry: SelectionChild;
  try { entry = await inspect(state, relative); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`The selected path no longer exists; refresh before changing access: ${relative}`);
  }
  await assertUnchanged(state);
  return entry;
}

/** Browse one immediate level; strict listings are used when replacing a broad access grant. */
export async function listProjectChildren(
  root: string, modulePath: string, relativeDir: string = '.', options: ListingOptions = {},
): Promise<SelectionChild[]> {
  const state = await context(root, modulePath);
  const relative = normalizeRelative(relativeDir);
  if (metadata(relative)) throw new Error('Git metadata is managed separately and cannot be browsed in the project tree.');
  const directory = resolveContained(state.project.root, relative);
  const canonicalDirectory = await state.project.resolveExisting(directory);
  checkCanonical(state, canonicalDirectory);
  if (!(await fs.stat(canonicalDirectory)).isDirectory()) throw new Error(`The selected project path is not a folder: ${relative}`);
  const entries = await fs.readdir(canonicalDirectory, { withFileTypes: true });
  const listed = await mapConcurrent(entries, 32, async entry => {
    if (key(entry.name) === key('.git')) return null;
    const literal = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    try { return await inspect(state, literal); }
    catch (error) {
      if (options.strict) throw new Error(`Cannot safely list ${literal}: ${(error as Error).message}`);
      return null;
    }
  });
  await assertUnchanged(state);
  return listed.filter((entry): entry is SelectionChild => entry !== null).sort((first, second) => {
    if (first.directory !== second.directory) return first.directory ? -1 : 1;
    const left = key(first.relative);
    const right = key(second.relative);
    return left < right ? -1 : left > right ? 1 : first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0;
  });
}
