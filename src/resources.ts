import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ContainedResolver, createContainedResolver, normalizeRelative, resolveContained } from './core/paths';
import { mapConcurrent } from './core/concurrency';
import { validateRegistry } from './core/registry';
import { AccessKind, ListingOptions, SelectionChild, SelectionState, selectedState, togglePathSelection } from './core/selection';
import { ModuleConfig, Registry } from './types';

export interface ResourceChild extends SelectionChild { selectable: boolean; hidden?: boolean }

const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const contains = (ancestor: string, target: string): boolean => ancestor === '.' || key(ancestor) === key(target) || key(target).startsWith(`${key(ancestor)}/`);
const overlaps = (first: string, second: string): boolean => contains(first, second) || contains(second, first);
const metadata = (relative: string): boolean => relative.split('/').some(segment => key(segment) === '.git');
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.';

function projectPaths(registry: Registry): string[] {
  return Object.values(registry.submodules).map(module => normalizeRelative(module.path));
}

/** A shared grant may not cover a registered project, its ancestors, or Git metadata. */
export function isResourcePath(registry: Registry, relative: string): boolean {
  try {
    const target = normalizeRelative(relative);
    return target !== '.' && !metadata(target) && !projectPaths(registry).some(project => overlaps(project, target));
  } catch { return false; }
}

/** Shared paths are always active; selecting one never re-enables a project. */
export function resourceScope(registry: Registry): ModuleConfig {
  return {
    ...registry.shared_resources,
    path: '.', enabled: true, restrict_paths: true,
    read_paths: [...registry.shared_resources.read_paths],
    write_paths: [...registry.shared_resources.write_paths],
    instruction_file: null,
  };
}

export function selectedResourceState(registry: Registry, relative: string, access: AccessKind): SelectionState {
  const target = normalizeRelative(relative);
  if (metadata(target) || projectPaths(registry).some(project => contains(project, target))) {
    return { checked: false, partial: false, inherited: false };
  }
  return selectedState(resourceScope(registry), target, access);
}

interface ResourceContext { root: string; resolver: ContainedResolver; projects: string[]; canonicalProjects: string[] }

async function context(root: string, registry: Registry): Promise<ResourceContext> {
  const resolver = await createContainedResolver(root);
  validateRegistry(registry, resolver.root);
  const projects = projectPaths(registry);
  const canonicalProjects = await mapConcurrent(projects, 16, async project => {
    const target = resolveContained(resolver.root, project);
    const canonical = await resolver.resolve(target);
    return normalizeRelative(path.relative(resolver.canonicalRoot, canonical) || '.');
  });
  return { root: resolver.root, resolver, projects, canonicalProjects };
}

async function assertUnchanged(state: ResourceContext): Promise<void> {
  const latest = await mapConcurrent(state.projects, 16, async project => {
    const canonical = await state.resolver.resolve(resolveContained(state.root, project));
    return normalizeRelative(path.relative(state.resolver.canonicalRoot, canonical) || '.');
  });
  if (latest.some((project, index) => key(project) !== key(state.canonicalProjects[index]))) {
    throw new Error('Registered project boundaries changed while reading workspace resources. Refresh before selecting access.');
  }
  await state.resolver.assertUnchanged();
}

async function canonicalRelative(state: ResourceContext, relative: string, existing = false): Promise<string> {
  const target = resolveContained(state.root, relative);
  const canonical = await (existing ? state.resolver.resolveExisting(target) : state.resolver.resolve(target));
  const resolved = normalizeRelative(path.relative(state.resolver.canonicalRoot, canonical) || '.');
  if (metadata(resolved)) throw new Error(`A shared resource enters Git metadata through a link: ${relative}`);
  return resolved;
}

async function entryType(state: ResourceContext, relative: string, resolved: string): Promise<SelectionChild> {
  const info = await fs.lstat(resolveContained(state.root, relative));
  const symbolicLink = info.isSymbolicLink();
  const followed = symbolicLink ? await fs.stat(resolveContained(state.resolver.canonicalRoot, resolved)) : info;
  if (!followed.isDirectory() && !followed.isFile()) throw new Error(`The workspace entry is not a regular file or directory: ${relative}`);
  return { relative, directory: followed.isDirectory(), ...(symbolicLink ? { symbolicLink: true } : {}) };
}

function insideProject(state: ResourceContext, relative: string, canonical: string): boolean {
  return state.projects.some(project => contains(project, relative))
    || state.canonicalProjects.some(project => contains(project, canonical));
}

function canSelect(state: ResourceContext, relative: string, canonical: string): boolean {
  return relative !== '.' && canonical !== '.' && !metadata(relative)
    && !state.projects.some(project => overlaps(project, relative))
    && !state.canonicalProjects.some(project => overlaps(project, canonical));
}

/** Browse only one level outside every project, including disabled projects and their aliases. */
export async function listWorkspaceChildren(
  root: string, registry: Registry, relative: string = '.', options: ListingOptions = {},
): Promise<ResourceChild[]> {
  const state = await context(root, registry);
  const children = await listChildren(state, relative, options);
  await assertUnchanged(state);
  return children;
}

async function listChildren(state: ResourceContext, relative: string, options: ListingOptions = {}): Promise<ResourceChild[]> {
  const directory = normalizeRelative(relative);
  if (metadata(directory)) throw new Error('Git metadata cannot be browsed as a workspace resource.');
  const canonical = await canonicalRelative(state, directory, true);
  if (insideProject(state, directory, canonical)) throw new Error(`Workspace resources cannot browse a registered project: ${directory}`);
  const directoryPath = resolveContained(state.resolver.canonicalRoot, canonical);
  if (!(await fs.stat(directoryPath)).isDirectory()) throw new Error(`The selected workspace path is not a folder: ${directory}`);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const children = await mapConcurrent(entries, 32, async (entry): Promise<ResourceChild | null> => {
    const literal = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    try {
      const childRelative = normalizeRelative(literal);
      if (metadata(childRelative)) throw new Error(`Git metadata is excluded from workspace resources: ${literal}`);
      // Reject lexical project boundaries before resolving their filesystem entries.
      if (state.projects.some(project => contains(project, childRelative))) {
        throw new Error(`Registered project is excluded from workspace resources: ${literal}`);
      }
      const resolved = await canonicalRelative(state, childRelative, true);
      if (insideProject(state, childRelative, resolved)) throw new Error(`A workspace resource enters a registered project through a link: ${literal}`);
      const child = await entryType(state, childRelative, resolved);
      const selectable = canSelect(state, childRelative, resolved);
      if (options.strict && !selectable) throw new Error(`A workspace resource folder contains a registered project boundary: ${literal}`);
      return { ...child, selectable };
    } catch (error) {
      if (options.strict) throw new Error(`Cannot safely list ${literal}: ${(error as Error).message}`);
      return null;
    }
  });
  return children.filter((child): child is ResourceChild => child !== null).sort((first, second) => {
    if (first.directory !== second.directory) return first.directory ? -1 : 1;
    return key(first.relative) < key(second.relative) ? -1 : key(first.relative) > key(second.relative) ? 1 : 0;
  });
}

async function validateGrants(state: ResourceContext, draft: Registry): Promise<void> {
  const grants = new Set([...draft.shared_resources.read_paths, ...draft.shared_resources.write_paths].map(normalizeRelative));
  await mapConcurrent([...grants], 16, async relative => {
    if (!isResourcePath(draft, relative) || !canSelect(state, relative, await canonicalRelative(state, relative))) {
      throw new Error(`A shared resource overlaps a registered project or Git metadata: ${relative}`);
    }
  });
}

async function validateClickedEntry(state: ResourceContext, relative: string, resolved: string, directory: boolean): Promise<SelectionChild> {
  let child: SelectionChild;
  try { child = await entryType(state, relative, resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error('This workspace file or folder changed since it was displayed. Refresh before selecting access.');
  }
  if (child.directory !== directory) throw new Error('This workspace file or folder changed since it was displayed. Refresh before selecting access.');
  return child;
}

/** Produce a shared-resource draft without modifying files, projects or the caller's registry. */
export async function toggleResourceSelection(
  root: string, registry: Registry, relative: string, access: AccessKind, checked: boolean, directory: boolean,
): Promise<Registry['shared_resources']> {
  const target = normalizeRelative(relative);
  if (!isResourcePath(registry, target)) throw new Error(`This path cannot be granted as a workspace resource: ${target}`);
  if (typeof directory !== 'boolean') throw new Error('The selected resource must specify whether it is a file or folder.');
  const state = await context(root, registry);
  const resolved = await canonicalRelative(state, target);
  if (!canSelect(state, target, resolved)) throw new Error(`A workspace resource overlaps a registered project or workspace root through a link: ${target}`);
  const selected = checked ? await validateClickedEntry(state, target, resolved, directory) : undefined;
  const updated = await togglePathSelection(resourceScope(registry), target, access, checked,
    (folder, options) => selected ? Promise.resolve([selected]) : listChildren(state, folder, options));
  const resources = {
    ...registry.shared_resources,
    read_paths: [...updated.read_paths], write_paths: [...updated.write_paths],
  };
  const draft = { ...registry, shared_resources: resources };
  validateRegistry(draft, state.root);
  // Recheck resulting grants against current targets before publishing the draft.
  await validateGrants(state, draft);
  if (checked) await validateClickedEntry(state, target, await canonicalRelative(state, target), directory);
  await assertUnchanged(state);
  return resources;
}

/**
 * Return the maximal safe resource roots. Only ancestors containing registered
 * projects are expanded; ordinary resource folders are never recursively scanned.
 * The workspace root itself is a UI aggregate, never a persisted access grant.
 */
export async function listWorkspaceSelectionRoots(root: string, registry: Registry): Promise<ResourceChild[]> {
  const state = await context(root, registry);
  const roots = await selectionRoots(state);
  await assertUnchanged(state);
  return roots;
}

async function selectionRoots(state: ResourceContext): Promise<ResourceChild[]> {
  if (state.projects.includes('.') || state.canonicalProjects.includes('.')) return [];
  const result: ResourceChild[] = [];
  const visit = async (directory: string): Promise<void> => {
    const canonical = await canonicalRelative(state, directory, true);
    if (insideProject(state, directory, canonical)) return;
    const directoryPath = resolveContained(state.resolver.canonicalRoot, canonical);
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const next = await mapConcurrent(entries, 32, async (entry): Promise<{ child?: ResourceChild; directory?: string }> => {
      const literal = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      let relative: string;
      try { relative = normalizeRelative(literal); }
      catch { return {}; } // Filenames that cannot form portable literal scopes are not granted.
      if (metadata(relative) || state.projects.some(project => contains(project, relative))) return {};
      let resolved: string;
      let child: SelectionChild;
      try {
        resolved = await canonicalRelative(state, relative, true);
        child = await entryType(state, relative, resolved);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') return {};
        if (!code && /^(?:A symbolic link or junction leaves|Cannot resolve a broken symbolic link|A shared resource enters Git metadata through a link|The workspace entry is not a regular file or directory)/i.test((error as Error).message)) return {};
        throw error; // Filesystem failures must not produce a partial broad selection.
      }
      if (insideProject(state, relative, resolved)) return {};
      if (canSelect(state, relative, resolved)) return { child: { ...child, selectable: true } };
      if (child.directory && !child.symbolicLink
        && (state.projects.some(project => contains(relative, project))
          || state.canonicalProjects.some(project => contains(resolved, project)))) return { directory: relative };
      return {};
    });
    for (const item of next) {
      if (item.child) result.push(item.child);
      else if (item.directory) await visit(item.directory);
    }
  };
  await visit('.');
  return result.sort((first, second) => key(first.relative) < key(second.relative) ? -1 : key(first.relative) > key(second.relative) ? 1 : 0);
}

/** Pure aggregate state; callers can reuse one frontier for both checkbox columns. */
export function workspaceSelectionState(registry: Registry, roots: ResourceChild[], access: AccessKind): SelectionState {
  if (access !== 'read' && access !== 'write') throw new Error('Access must be read or write.');
  const states = roots.map(root => selectedResourceState(registry, root.relative, access));
  const checked = states.length > 0 && states.every(state => state.checked);
  const choices = access === 'write' ? registry.shared_resources.write_paths
    : [...registry.shared_resources.read_paths, ...registry.shared_resources.write_paths];
  return { checked, partial: !checked && choices.length > 0, inherited: false };
}

export async function selectedWorkspaceState(root: string, registry: Registry, access: AccessKind): Promise<SelectionState> {
  return workspaceSelectionState(registry, await listWorkspaceSelectionRoots(root, registry), access);
}

function compactResourcePaths(paths: string[]): string[] {
  const selected: string[] = [];
  for (const relative of paths.map(normalizeRelative)) {
    if (selected.some(ancestor => contains(ancestor, relative))) continue;
    for (let index = selected.length - 1; index >= 0; index--) {
      if (contains(relative, selected[index])) selected.splice(index, 1);
    }
    selected.push(relative);
  }
  return selected.sort((first, second) => key(first) < key(second) ? -1 : key(first) > key(second) ? 1 : 0);
}

/** Select all current safe resource roots, or clear the corresponding shared grants. */
export async function toggleWorkspaceSelection(
  root: string, registry: Registry, access: AccessKind, checked: boolean,
): Promise<Registry['shared_resources']> {
  if (access !== 'read' && access !== 'write') throw new Error('Access must be read or write.');
  if (typeof checked !== 'boolean') throw new Error('The checkbox value must be true or false.');
  const state = await context(root, registry);
  const resources = {
    ...registry.shared_resources,
    read_paths: [...registry.shared_resources.read_paths], write_paths: [...registry.shared_resources.write_paths],
  };
  if (checked) {
    const roots = await selectionRoots(state);
    const field = access === 'write' ? 'write_paths' : 'read_paths';
    resources[field] = compactResourcePaths([...resources[field], ...roots.map(entry => entry.relative)]);
  } else {
    if (access === 'read') resources.read_paths = [];
    resources.write_paths = [];
  }
  const draft = { ...registry, shared_resources: resources };
  validateRegistry(draft, state.root);
  await validateGrants(state, draft);
  await assertUnchanged(state);
  return resources;
}
