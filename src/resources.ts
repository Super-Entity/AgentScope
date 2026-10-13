import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelative, resolveContained, verifyContained } from './core/paths';
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

interface ResourceContext { root: string; projects: string[]; canonicalProjects: string[] }

async function context(root: string, registry: Registry): Promise<ResourceContext> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  validateRegistry(registry, canonicalRoot);
  const projects = projectPaths(registry);
  const canonicalProjects = await Promise.all(projects.map(async project => {
    const target = resolveContained(canonicalRoot, project);
    const canonical = await verifyContained(canonicalRoot, target);
    return normalizeRelative(path.relative(canonicalRoot, canonical) || '.');
  }));
  return { root: canonicalRoot, projects, canonicalProjects };
}

async function canonicalRelative(state: ResourceContext, relative: string): Promise<string> {
  const canonical = await verifyContained(state.root, resolveContained(state.root, relative));
  const resolved = normalizeRelative(path.relative(state.root, canonical) || '.');
  if (metadata(resolved)) throw new Error(`A shared resource enters Git metadata through a link: ${relative}`);
  return resolved;
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
  const directory = normalizeRelative(relative);
  if (metadata(directory)) throw new Error('Git metadata cannot be browsed as a workspace resource.');
  const canonical = await canonicalRelative(state, directory);
  if (insideProject(state, directory, canonical)) throw new Error(`Workspace resources cannot browse a registered project: ${directory}`);
  const directoryPath = resolveContained(state.root, directory);
  if (!(await fs.stat(directoryPath)).isDirectory()) throw new Error(`The selected workspace path is not a folder: ${directory}`);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry): Promise<ResourceChild | null> => {
    const literal = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    try {
      const childRelative = normalizeRelative(literal);
      if (metadata(childRelative)) throw new Error(`Git metadata is excluded from workspace resources: ${literal}`);
      // Reject lexical project boundaries before resolving their filesystem entries.
      if (state.projects.some(project => contains(project, childRelative))) {
        throw new Error(`Registered project is excluded from workspace resources: ${literal}`);
      }
      const resolved = await canonicalRelative(state, childRelative);
      if (insideProject(state, childRelative, resolved)) throw new Error(`A workspace resource enters a registered project through a link: ${literal}`);
      const childPath = resolveContained(state.root, childRelative);
      const info = await fs.lstat(childPath);
      const symbolicLink = info.isSymbolicLink();
      const followed = symbolicLink ? await fs.stat(childPath) : info;
      if (!followed.isDirectory() && !followed.isFile()) throw new Error(`The workspace entry is not a regular file or directory: ${literal}`);
      const selectable = canSelect(state, childRelative, resolved);
      if (options.strict && !selectable) throw new Error(`A workspace resource folder contains a registered project boundary: ${literal}`);
      return {
        relative: childRelative, directory: followed.isDirectory(), selectable,
        ...(symbolicLink ? { symbolicLink: true } : {}),
      };
    } catch (error) {
      if (options.strict) throw new Error(`Cannot safely list ${literal}: ${(error as Error).message}`);
      return null;
    }
  }));
  return children.filter((child): child is ResourceChild => child !== null).sort((first, second) => {
    if (first.directory !== second.directory) return first.directory ? -1 : 1;
    return key(first.relative) < key(second.relative) ? -1 : key(first.relative) > key(second.relative) ? 1 : 0;
  });
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
  if (checked) {
    const children = await listWorkspaceChildren(root, registry, parent(target));
    const latest = children.find(child => key(child.relative) === key(target));
    if (!latest || !latest.selectable || latest.directory !== directory) {
      throw new Error('This workspace file or folder changed since it was displayed. Refresh before selecting access.');
    }
  }
  const updated = await togglePathSelection(resourceScope(registry), target, access, checked,
    (folder, options) => listWorkspaceChildren(root, registry, folder, options));
  const resources = {
    ...registry.shared_resources,
    read_paths: [...updated.read_paths], write_paths: [...updated.write_paths],
  };
  const draft = { ...registry, shared_resources: resources };
  validateRegistry(draft, state.root);
  // Validate every resulting grant physically as well as lexically before publishing the draft.
  for (const grant of [...resources.read_paths, ...resources.write_paths]) {
    const normalized = normalizeRelative(grant);
    if (!isResourcePath(draft, normalized) || !canSelect(state, normalized, await canonicalRelative(state, normalized))) {
      throw new Error(`A shared resource overlaps a registered project or Git metadata: ${grant}`);
    }
  }
  return resources;
}

/**
 * Return the maximal safe resource roots. Only ancestors containing registered
 * projects are expanded; ordinary resource folders are never recursively scanned.
 * The workspace root itself is a UI aggregate, never a persisted access grant.
 */
export async function listWorkspaceSelectionRoots(root: string, registry: Registry): Promise<ResourceChild[]> {
  return selectionRoots(await context(root, registry));
}

async function selectionRoots(state: ResourceContext): Promise<ResourceChild[]> {
  if (state.projects.includes('.') || state.canonicalProjects.includes('.')) return [];
  const result: ResourceChild[] = [];
  const visit = async (directory: string): Promise<void> => {
    const directoryPath = resolveContained(state.root, directory);
    const canonical = await canonicalRelative(state, directory);
    if (insideProject(state, directory, canonical)) return;
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const literal = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      let relative: string;
      try { relative = normalizeRelative(literal); }
      catch { continue; } // Filenames that cannot form portable literal scopes are not granted.
      if (metadata(relative) || state.projects.some(project => contains(project, relative))) continue;
      const target = resolveContained(state.root, relative);
      let resolved: string;
      let info;
      try {
        resolved = await canonicalRelative(state, relative);
        info = await fs.lstat(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') continue;
        if (!code && /^(?:A symbolic link or junction leaves|Cannot resolve a broken symbolic link|A shared resource enters Git metadata through a link)/i.test((error as Error).message)) continue;
        throw error; // Permission or filesystem failures must not produce a partial broad selection.
      }
      if (insideProject(state, relative, resolved)) continue;
      const symbolicLink = info.isSymbolicLink();
      const followed = symbolicLink ? await fs.stat(target) : info;
      if (!followed.isDirectory() && !followed.isFile()) continue;
      if (canSelect(state, relative, resolved)) {
        result.push({ relative, directory: followed.isDirectory(), selectable: true, ...(symbolicLink ? { symbolicLink: true } : {}) });
      } else if (followed.isDirectory() && !symbolicLink
        && (state.projects.some(project => contains(relative, project))
          || state.canonicalProjects.some(project => contains(resolved, project)))) {
        await visit(relative);
      }
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
  for (const grant of [...resources.read_paths, ...resources.write_paths]) {
    const relative = normalizeRelative(grant);
    if (!isResourcePath(draft, relative) || !canSelect(state, relative, await canonicalRelative(state, relative))) {
      throw new Error(`A shared resource overlaps a registered project or Git metadata: ${grant}`);
    }
  }
  return resources;
}
