import { ModuleConfig } from '../types';
import { normalizeRelative } from './paths';

export type AccessKind = 'read' | 'write';
export interface SelectionState { checked: boolean; partial: boolean; inherited: boolean }
export interface SelectionChild { relative: string; directory: boolean; symbolicLink?: boolean }
export interface ListingOptions { strict?: boolean }
export type ListSelectionChildren = (relativeDir: string, options?: ListingOptions) => Promise<SelectionChild[]>;

const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (first: string, second: string): boolean => key(first) === key(second);
const contains = (ancestor: string, target: string): boolean => ancestor === '.' || same(ancestor, target) || key(target).startsWith(`${key(ancestor)}/`);
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.';
const metadataPath = (relative: string): boolean => relative.split('/').some(segment => key(segment) === key('.git'));

function normalizedPath(value: string): string {
  const normalized = normalizeRelative(value);
  if (metadataPath(normalized)) throw new Error('Git metadata is managed separately and cannot be selected in the project tree.');
  return normalized;
}

function checkKind(kind: AccessKind): void {
  if (kind !== 'read' && kind !== 'write') throw new Error('Access must be read or write.');
}

/** Keep the minimal explicit positive grants; a parent already covers all descendants. */
function compact(paths: string[]): string[] {
  if (!Array.isArray(paths)) throw new Error('Access paths must be arrays of literal path strings.');
  const result: string[] = [];
  for (const value of paths.map(normalizeRelative)) {
    if (result.some(ancestor => contains(ancestor, value))) continue;
    for (let index = result.length - 1; index >= 0; index--) {
      if (contains(value, result[index])) result.splice(index, 1);
    }
    result.push(value);
  }
  return result.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function stateFromScopes(target: string, scopes: string[]): SelectionState {
  const covering = scopes.filter(scope => contains(scope, target));
  const checked = covering.length > 0;
  return {
    checked,
    partial: !checked && scopes.some(scope => contains(target, scope)),
    inherited: checked && covering.some(scope => !same(scope, target)),
  };
}

/** Normalize a scope once when producing many rows from the same draft snapshot. */
export function selectionReader(module: ModuleConfig): (relative: string) => { read: SelectionState; write: SelectionState } {
  const read = module.enabled !== true ? [] : module.restrict_paths === false ? ['.'] : compact([...module.read_paths, ...module.write_paths]);
  const write = module.enabled !== true ? [] : module.restrict_paths === false ? ['.'] : compact(module.write_paths);
  return relative => {
    const target = normalizedPath(relative);
    return { read: stateFromScopes(target, read), write: stateFromScopes(target, write) };
  };
}

export function selectedState(module: ModuleConfig, relative: string, kind: AccessKind): SelectionState {
  checkKind(kind);
  const target = normalizedPath(relative);
  const scopes = module.enabled !== true ? [] : module.restrict_paths === false ? ['.']
    : compact(kind === 'write' ? module.write_paths : [...module.read_paths, ...module.write_paths]);
  return stateFromScopes(target, scopes);
}

function grant(paths: string[], target: string): string[] { return compact([...paths, target]); }

function validateChildren(directory: string, children: SelectionChild[]): SelectionChild[] {
  if (!Array.isArray(children)) throw new Error(`Cannot safely list the project folder: ${directory}`);
  const names = new Set<string>();
  return children.map(child => {
    if (!child || typeof child.relative !== 'string' || typeof child.directory !== 'boolean') {
      throw new Error(`Cannot safely interpret a child of the project folder: ${directory}`);
    }
    const relative = normalizedPath(child.relative);
    if (relative === '.' || !same(parent(relative), directory)) {
      throw new Error(`A folder listing must contain only immediate children of ${directory}: ${relative}`);
    }
    if (names.has(key(relative))) throw new Error(`Duplicate project child in folder listing: ${relative}`);
    names.add(key(relative));
    return { relative, directory: child.directory, ...(child.symbolicLink ? { symbolicLink: true } : {}) };
  });
}

/** Replace only the covering ancestor by explicit siblings along the excluded path. */
async function splitAncestor(
  ancestor: string, target: string, listChildren: ListSelectionChildren, cache: Map<string, SelectionChild[]>,
): Promise<string[]> {
  const ancestorSegments = ancestor === '.' ? [] : ancestor.split('/');
  const targetSegments = target.split('/');
  const siblings: string[] = [];
  let directory = ancestor;
  for (let index = ancestorSegments.length; index < targetSegments.length; index++) {
    const cacheKey = key(directory);
    let children = cache.get(cacheKey);
    if (!children) {
      children = validateChildren(directory, await listChildren(directory, { strict: true }));
      cache.set(cacheKey, children);
    }
    if (children.some(child => child.symbolicLink)) {
      throw new Error(`Cannot safely split access through a symbolic link or junction in ${directory}. Clear the parent grant and select the required paths individually.`);
    }
    const wanted = directory === '.' ? targetSegments[index] : `${directory}/${targetSegments[index]}`;
    const branch = children.find(child => same(child.relative, wanted));
    if (!branch) throw new Error(`The selected path no longer exists; refresh before changing access: ${target}`);
    for (const child of children) if (!same(child.relative, branch.relative)) siblings.push(child.relative);
    if (index < targetSegments.length - 1) {
      if (!branch.directory) throw new Error(`The selected path crosses a file instead of a folder: ${branch.relative}`);
      directory = branch.relative;
    }
  }
  return siblings;
}

async function removeGrant(
  paths: string[], target: string, listChildren: ListSelectionChildren, cache: Map<string, SelectionChild[]>,
): Promise<string[]> {
  const kept: string[] = [];
  for (const scope of compact(paths)) {
    if (contains(target, scope)) continue;
    if (contains(scope, target)) kept.push(...await splitAncestor(scope, target, listChildren, cache));
    else kept.push(scope);
  }
  return compact(kept);
}

async function validateTarget(target: string, listChildren: ListSelectionChildren): Promise<void> {
  if (target === '.') {
    validateChildren('.', await listChildren('.', { strict: false }));
    return;
  }
  const directory = parent(target);
  const children = validateChildren(directory, await listChildren(directory, { strict: false }));
  if (!children.some(child => same(child.relative, target))) {
    throw new Error(`The selected path no longer exists; refresh before changing access: ${target}`);
  }
}

/** Return a draft only; no policy or filesystem writes happen here. */
export async function togglePathSelection(
  module: ModuleConfig, relative: string, kind: AccessKind, checked: boolean, listChildren: ListSelectionChildren,
): Promise<ModuleConfig> {
  checkKind(kind);
  if (typeof checked !== 'boolean') throw new Error('The checkbox value must be true or false.');
  const target = normalizedPath(relative);
  const updated: ModuleConfig = { ...module, read_paths: [...module.read_paths], write_paths: [...module.write_paths] };
  if (module.enabled !== true) {
    if (!checked) return updated;
    // Individual selection is a fresh grant, never a restoration of older hidden settings.
    updated.enabled = true;
    updated.restrict_paths = true;
    updated.read_paths = [];
    updated.write_paths = [];
  } else if (module.restrict_paths === false) {
    updated.restrict_paths = true;
    updated.read_paths = [];
    updated.write_paths = ['.'];
  }
  if (checked) {
    await validateTarget(target, listChildren);
    if (kind === 'write') updated.write_paths = grant(updated.write_paths, target);
    else updated.read_paths = grant(updated.read_paths, target);
  } else {
    const cache = new Map<string, SelectionChild[]>();
    if (kind === 'read') updated.read_paths = await removeGrant(updated.read_paths, target, listChildren, cache);
    updated.write_paths = await removeGrant(updated.write_paths, target, listChildren, cache);
  }
  return updated;
}
