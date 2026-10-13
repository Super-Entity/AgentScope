import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, SyntaxKind, type Node } from 'jsonc-parser';
import { assertDirectoryIdentity, captureDirectoryIdentity, normalizeRelative, resolveContained, verifyContained } from './core/paths';
import { parseJsoncStrict, validateRegistry } from './core/registry';
import { isResourcePath } from './resources';
import { applyPlan } from './transactions';
import { DirectoryIdentity, Registry } from './types';
import type { ApplyOptions } from './workspace';

export interface ScopePreset {
  registry: Registry;
  hidden: Record<string, boolean>;
  resourceHidden: Record<string, boolean>;
  options: ApplyOptions;
  [key: string]: unknown;
}

export interface PresetStore {
  version: 1;
  presets: Record<string, ScopePreset>;
  [key: string]: unknown;
}

const relativeStore = '.vscode/agentscope-presets.json';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const samePath = (first: string, second: string): boolean => process.platform === 'win32'
  ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second);

function validateName(name: string): void {
  if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > 80
    || /[\x00-\x1f\x7f]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    throw new Error('A preset name must contain 1–80 characters without surrounding whitespace, control characters or reserved object names.');
  }
}

function validateOptions(value: unknown): asserts value is ApplyOptions {
  if (!object(value) || ['generateCodexProfile', 'excludeFromSearch', 'allowNetwork'].some(field => typeof value[field] !== 'boolean')
    || typeof value.profileName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.profileName)) {
    throw new Error('Preset options require boolean generation, search and network settings and a valid permission profile name.');
  }
}

function validatePreset(value: unknown, root: string): asserts value is ScopePreset {
  if (!object(value) || !object(value.registry)) throw new Error('A preset must contain a scope registry.');
  validateRegistry(value.registry as unknown as Registry, root);
  const registry = value.registry as unknown as Registry;
  if (!object(value.hidden) || !object(value.resourceHidden)) throw new Error('Preset visibility settings must be objects of boolean choices.');
  for (const [name, hidden] of Object.entries(value.hidden)) {
    if (!Object.hasOwn(registry.submodules, name) || typeof hidden !== 'boolean') {
      throw new Error(`Invalid preset project visibility choice: ${name}`);
    }
  }
  for (const [relative, hidden] of Object.entries(value.resourceHidden)) {
    if (typeof hidden !== 'boolean' || normalizeRelative(relative) !== relative || !isResourcePath(registry, relative)) {
      throw new Error(`Invalid preset workspace resource visibility choice: ${relative}`);
    }
  }
  validateOptions(value.options);
}

/** JSONC's ordinary object parser treats __proto__ as a setter; define keys safely. */
function nodeValue(node: Node): unknown {
  if (node.type === 'array') return (node.children ?? []).map(nodeValue);
  if (node.type !== 'object') return node.value;
  const result: Record<string, unknown> = {};
  for (const property of node.children ?? []) {
    Object.defineProperty(result, String(property.children![0].value), {
      value: nodeValue(property.children![1]), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function parseStore(text: string | null, root: string): PresetStore {
  if (text === null) return { version: 1, presets: {} };
  parseJsoncStrict(text, 'AgentScope presets');
  const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!tree) throw new Error('AgentScope presets must contain a JSON/JSONC object.');
  const value = nodeValue(tree);
  if (!object(value) || value.version !== 1 || !object(value.presets)) {
    throw new Error('AgentScope presets must use version 1 and contain a presets object.');
  }
  for (const [name, preset] of Object.entries(value.presets)) {
    validateName(name);
    validatePreset(preset, root);
  }
  return value as unknown as PresetStore;
}

interface StoredPresets { root: string; identity: DirectoryIdentity; path: string; text: string | null; store: PresetStore }

/** Preset files and their configuration parent may never redirect through a link. */
async function readStored(root: string): Promise<StoredPresets> {
  // The host supplies the canonical root of the selected workspace. Re-resolving
  // a replaced root must not redirect a stale draft into another workspace.
  const selectedRoot = path.resolve(root);
  const canonicalRoot = await fs.realpath(selectedRoot);
  if (!samePath(selectedRoot, canonicalRoot)) {
    throw new Error('Workspace root changed since it was selected; refresh before managing presets.');
  }
  const identity = await captureDirectoryIdentity(canonicalRoot);
  const target = resolveContained(canonicalRoot, relativeStore);
  const canonical = await verifyContained(canonicalRoot, target);
  if (!samePath(canonical, target)) throw new Error('Refusing a symbolic link or junction in the AgentScope presets configuration path.');
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('The AgentScope presets target must be a regular file.');
  } catch (error) { if (!missing(error)) throw error; }
  let text: string | null;
  try { text = await fs.readFile(target, 'utf8'); }
  catch (error) { if (!missing(error)) throw error; text = null; }
  await assertDirectoryIdentity(canonicalRoot, identity);
  return { root: canonicalRoot, identity, path: target, text, store: parseStore(text, canonicalRoot) };
}

export async function readPresets(root: string): Promise<PresetStore> {
  return structuredClone((await readStored(root)).store);
}

function equivalent(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((value, index) => equivalent(value, second[index]));
  }
  if (!object(first) || !object(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length
    && keys.every(key => Object.hasOwn(second, key) && equivalent(first[key], second[key]));
}

/** Only these maps replace their membership; other objects can carry user annotations. */
function authoritativeMap(keys: string[]): boolean {
  return (keys.length === 1 && ['hidden', 'resourceHidden'].includes(keys[0]))
    || (keys.length === 2 && keys[0] === 'registry' && keys[1] === 'submodules');
}

function mergeAnnotations(previous: unknown, incoming: unknown, keys: string[] = []): unknown {
  if (!object(incoming)) return structuredClone(incoming);
  const result: Record<string, unknown> = {};
  if (object(previous) && !authoritativeMap(keys)) {
    for (const [key, value] of Object.entries(previous)) {
      Object.defineProperty(result, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    }
  }
  for (const [key, value] of Object.entries(incoming)) {
    const before = object(previous) && Object.hasOwn(previous, key) ? previous[key] : undefined;
    Object.defineProperty(result, key, {
      value: mergeAnnotations(before, value, [...keys, key]), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function comments(text: string): string[] {
  const scanner = createScanner(text, false);
  const result: string[] = [];
  let token: SyntaxKind;
  while ((token = scanner.scan()) !== SyntaxKind.EOF) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      result.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return result;
}

/** Deleting a JSONC member can also consume a neighbouring comment; keep its text. */
function preserveComments(before: string, after: string, keys: Array<string | number>, eol: string, indent: string): string {
  const remaining = new Map<string, number>();
  for (const comment of comments(after)) remaining.set(comment, (remaining.get(comment) ?? 0) + 1);
  const lost = comments(before).filter(comment => {
    const count = remaining.get(comment) ?? 0;
    if (count === 0) return true;
    remaining.set(comment, count - 1);
    return false;
  });
  if (lost.length === 0) return after;
  const tree = parseTree(after, [], { allowTrailingComma: true, disallowComments: false });
  const parent = [...keys.slice(0, -1)];
  let container = tree && findNodeAtLocation(tree, parent);
  while (parent.length && (!container || !['array', 'object'].includes(container.type))) {
    parent.pop();
    container = tree && findNodeAtLocation(tree, parent);
  }
  if (!container || !['array', 'object'].includes(container.type)) throw new Error('Cannot preserve comments in the edited preset container.');
  const baseIndent = /^[ \t]*/.exec(after.slice(after.lastIndexOf('\n', container.offset - 1) + 1, container.offset))?.[0] ?? '';
  const insertion = `${eol}${lost.map(comment => `${baseIndent}${indent}${comment}`).join(eol)}${eol}${baseIndent}`;
  const offset = container.offset + container.length - 1;
  return `${after.slice(0, offset)}${insertion}${after.slice(offset)}`;
}

function editPreset(stored: StoredPresets, name: string, preset: ScopePreset | undefined): string {
  if (stored.text === null) return `${JSON.stringify({ version: 1, presets: { [name]: preset } }, null, 2)}\n`;
  const indent = /\n([ \t]+)"/.exec(stored.text)?.[1];
  const options = {
    formattingOptions: {
      insertSpaces: !indent?.includes('\t'), tabSize: indent && !indent.includes('\t') ? indent.length : 2,
      eol: stored.text.includes('\r\n') ? '\r\n' : '\n',
    },
  };
  let text = stored.text;
  const edit = (keys: Array<string | number>, value: unknown): void => {
    const edits = modify(text, keys, value, options);
    const edited = applyEdits(text, edits);
    text = edits.some(change => comments(text.slice(change.offset, change.offset + change.length)).length > 0)
      ? preserveComments(text, edited, keys, options.formattingOptions.eol, indent ?? '  ') : edited;
  };
  const sync = (keys: Array<string | number>, before: unknown, after: unknown): void => {
    if (equivalent(before, after)) return;
    if (object(before) && object(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) edit([...keys, key], undefined);
      }
      for (const key of Object.keys(after)) {
        sync([...keys, key], Object.hasOwn(before, key) ? before[key] : undefined, after[key]);
      }
    } else if (Array.isArray(before) && Array.isArray(after)) {
      for (let index = 0; index < Math.min(before.length, after.length); index++) {
        sync([...keys, index], before[index], after[index]);
      }
      for (let index = before.length - 1; index >= after.length; index--) edit([...keys, index], undefined);
      for (let index = before.length; index < after.length; index++) edit([...keys, index], after[index]);
    } else edit(keys, after);
  };
  sync(['presets', name], Object.hasOwn(stored.store.presets, name) ? stored.store.presets[name] : undefined, preset);
  return text;
}

async function save(stored: StoredPresets, text: string, validateBeforeWrite?: () => void | Promise<void>): Promise<void> {
  parseStore(text, stored.root);
  if (text === stored.text) return;
  if (validateBeforeWrite) await validateBeforeWrite();
  await applyPlan({
    changes: [{ path: stored.path, before: stored.text, after: text }], warnings: [],
    directoryChecks: [{ path: stored.root, identity: stored.identity }],
    pathChecks: [
      { root: stored.root, path: stored.root, resolved: stored.root },
      { root: stored.root, path: stored.path, resolved: stored.path },
    ],
  }, validateBeforeWrite);
}

/** Save a named draft only. Applying its permissions is a separate ordinary Apply operation. */
export async function writePreset(root: string, name: string, preset: ScopePreset, validateBeforeWrite?: () => void | Promise<void>): Promise<void> {
  validateName(name);
  const stored = await readStored(root);
  const snapshot = structuredClone(preset);
  validatePreset(snapshot, stored.root);
  // Preserve annotations at every level, while the draft owns map membership and permissions.
  const next = mergeAnnotations(Object.hasOwn(stored.store.presets, name) ? stored.store.presets[name] : undefined, snapshot) as ScopePreset;
  await save(stored, editPreset(stored, name, next), validateBeforeWrite);
}

export async function deletePreset(root: string, name: string, validateBeforeWrite?: () => void | Promise<void>): Promise<void> {
  validateName(name);
  const stored = await readStored(root);
  if (!Object.hasOwn(stored.store.presets, name)) return;
  await save(stored, editPreset(stored, name, undefined), validateBeforeWrite);
}
