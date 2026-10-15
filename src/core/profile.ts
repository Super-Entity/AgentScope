import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as TOML from '@iarna/toml';
import { ProfileOptions, ProfileOutput, Registry } from '../types';
import { normalizeRelative, resolveContained } from './paths';
import { validateRegistry } from './registry';
import { profileTarget, resolveFilesystemMode, runtimeWorkspaceRoot } from './runtimePaths';

const bareProfilePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const legacySandboxKeys = ['sandbox_mode', 'sandbox_workspace_write', 'sandbox_read_only', 'sandbox_danger_full_access'];
const quote = (value: string): string => JSON.stringify(value);
const beginMarker = (name: string): string => `# BEGIN AgentScope managed profile: ${name}`;
const endMarker = (name: string): string => `# END AgentScope managed profile: ${name}`;

function checkName(name: string): void {
  if (typeof name !== 'string' || !name.length || name.length > 128 || name !== name.trim() ||
      /[\x00-\x1f\x7f\u2028\u2029]/.test(name) || name.startsWith(':') ||
      ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('A permission profile name must contain 1–128 characters without surrounding whitespace, control characters or a reserved name.');
  }
}

const profileKey = (name: string): string => bareProfilePattern.test(name) ? name : quote(name);

/** Storage verifies symlinks before this pure function creates a profile. */
export function generateProfile(registry: Registry, options: ProfileOptions): ProfileOutput {
  checkName(options.profileName);
  if (!path.isAbsolute(options.root)) { throw new Error('A permission profile requires an absolute workspace root.'); }
  if (typeof options.allowNetwork !== 'boolean') { throw new Error('The network setting must be true or false.'); }
  if (options.description !== undefined && typeof options.description !== 'string') { throw new Error('A permission profile description must be a string.'); }
  validateRegistry(registry, options.root);
  const root = path.resolve(options.root);
  const runtimeRoot = options.runtimeRoot ?? runtimeWorkspaceRoot(root);
  const filesystemMode = resolveFilesystemMode(runtimeRoot, options.filesystemMode);
  const broadReadAccess = filesystemMode === 'windows-compatible';
  const targetPath = (target: string): string => profileTarget(root, target, runtimeRoot);
  const entries = new Map<string, 'deny' | 'read' | 'write'>([[':root', broadReadAccess ? 'read' : 'deny'], [':minimal', 'read'], [':tmpdir', 'write']]);
  const grant = (target: string, mode: 'read' | 'write'): void => {
    const runtimeTarget = targetPath(target);
    const previous = entries.get(runtimeTarget);
    if (previous !== 'write') { entries.set(runtimeTarget, mode); }
  };
  for (const configuration of ['.gitmodules', '.codex']) { grant(resolveContained(root, configuration), 'read'); }
  for (const resource of registry.shared_resources.read_paths) { grant(resolveContained(root, resource), 'read'); }
  for (const resource of registry.shared_resources.write_paths) { grant(resolveContained(root, resource), 'write'); }
  for (const module of Object.values(registry.submodules)) {
    const moduleRoot = resolveContained(root, module.path);
    if (!module.enabled) {
      if (!broadReadAccess) entries.set(targetPath(moduleRoot), 'deny');
      continue;
    }
    if (!module.restrict_paths) { grant(moduleRoot, 'write'); }
    else {
      for (const relative of module.read_paths) { grant(resolveContained(moduleRoot, relative), 'read'); }
      for (const relative of module.write_paths) { grant(resolveContained(moduleRoot, relative), 'write'); }
    }
  }
  for (const [paths, mode] of [[options.gitReadPaths || [], 'read'], [options.gitWritePaths || [], 'write']] as const) {
    for (const gitPath of paths) {
      if (!path.isAbsolute(gitPath)) { throw new Error(`Verified Git paths must be absolute: ${gitPath}`); }
      const relative = path.relative(root, gitPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Git metadata must stay within the selected workspace: ${gitPath}`);
      }
      // These exact locations are supplied after pointer ownership/realpath checks.
      grant(path.resolve(gitPath), mode);
    }
  }
  if (broadReadAccess) {
    const writes = [...entries].filter(([target, mode]) => mode === 'write' && !target.startsWith(':')).map(([target]) => target);
    const contains = (ancestor: string, target: string): boolean => {
      const relative = path.win32.relative(ancestor, target);
      return relative === '' || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
    };
    for (const [target, mode] of entries) {
      if (mode !== 'read' || target.startsWith(':')) continue;
      // Root already allows these reads. Redundant read-only entries can prevent
      // the elevated Windows sandbox from reopening selected writable descendants.
      if (!writes.some(ancestor => contains(ancestor, target))) {
        entries.delete(target);
      } else if (writes.some(descendant => contains(target, descendant))) {
        throw new Error(`Windows compatibility cannot preserve the read-only path ${target} with a writable descendant. Use WSL2 or strict mode with a compatible MXC sandbox; write permissions were not broadened.`);
      }
    }
  }
  const warnings = ['Permission profiles require a compatible Codex client. Saving settings does not change an already running session.'];
  const modeComments = [`# Filesystem mode: ${filesystemMode}.`];
  if (broadReadAccess) {
    const warning = 'Windows compatibility allows OS-level reads of all files, including disabled projects and unselected paths. Read selections do not restrict OS-level reads; write grants remain limited to selected paths and the temporary directory.';
    warnings.push(warning, 'Windows compatibility does not guarantee split write-path enforcement with an unelevated sandbox. Use a compatible elevated Windows sandbox, or WSL2/strict mode.');
    modeComments.push(`# WARNING: ${warning}`, '# Unelevated Windows sandboxes may not support split write paths.');
  } else if (resolveFilesystemMode(runtimeRoot) === 'windows-compatible') {
    warnings.push('Strict filesystem permissions on native Windows require a compatible MXC sandbox. If unavailable, use WSL2 or explicitly choose Windows compatibility.');
  }
  const lines = [
    `# Generated by AgentScope for this workspace. Start a new Codex session to load changes.`,
    ...modeComments,
    ...(options.description !== undefined ? [`[permissions.${profileKey(options.profileName)}]`, `description = ${quote(options.description)}`, ''] : []),
    `[permissions.${profileKey(options.profileName)}.filesystem]`,
    ...[...entries].map(([target, mode]) => `${quote(target)} = ${quote(mode)}`),
    '',
    `[permissions.${profileKey(options.profileName)}.network]`,
    `enabled = ${options.allowNetwork}`,
    '',
  ];
  const text = lines.join('\n');
  parseToml(text, 'Generated permission profile');
  return {
    text, warnings, broadReadAccess,
  };
}

function parseToml(text: string, label: string): Record<string, unknown> {
  try { return TOML.parse(text) as Record<string, unknown>; }
  catch (error) { throw new Error(`${label} contains invalid TOML: ${(error as Error).message}`); }
}

interface TomlStatement { start: number; end: number; text: string; table: boolean; assignmentKey?: string; comment?: string }

/** Locate statements without mistaking a multiline string for a table or key. */
function statements(text: string): TomlStatement[] {
  const result: TomlStatement[] = [];
  let start = 0;
  let quoteKind: 'basic' | 'literal' | 'multiBasic' | 'multiLiteral' | null = null;
  let escaped = false;
  let commentStart = -1;
  let arrayDepth = 0;
  let objectDepth = 0;
  let index = 0;
  const finish = (end: number): void => {
    const value = text.slice(start, end);
    const trimmed = value.trimStart();
    const assignment = /^\s*(default_permissions|"default_permissions"|'default_permissions')\s*=/.exec(value);
    result.push({ start, end, text: value, table: trimmed.startsWith('['), assignmentKey: assignment ? 'default_permissions' : undefined,
      comment: commentStart >= start ? text.slice(commentStart, end).trimEnd() : undefined });
    start = end;
    commentStart = -1;
  };
  for (; index < text.length; index++) {
    const character = text[index];
    if (commentStart >= start && quoteKind === null) {
      if (character === '\n') { if (arrayDepth === 0 && objectDepth === 0) { finish(index + 1); } else { commentStart = -1; } }
      continue;
    }
    if (quoteKind === 'basic' || quoteKind === 'multiBasic') {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (quoteKind === 'multiBasic' && text.slice(index, index + 3) === '"""') {
        while (text[index + 3] === '"') { index++; }
        index += 2; quoteKind = null;
      } else if (quoteKind === 'basic' && character === '"') { quoteKind = null; }
      continue;
    }
    if (quoteKind === 'literal' || quoteKind === 'multiLiteral') {
      if (quoteKind === 'multiLiteral' && text.slice(index, index + 3) === "'''") {
        while (text[index + 3] === "'") { index++; }
        index += 2; quoteKind = null;
      } else if (quoteKind === 'literal' && character === "'") { quoteKind = null; }
      continue;
    }
    if (character === '#') { commentStart = index; continue; }
    if (character === '"' || character === "'") {
      const triple = text.slice(index, index + 3) === character.repeat(3);
      quoteKind = character === '"' ? triple ? 'multiBasic' : 'basic' : triple ? 'multiLiteral' : 'literal';
      if (triple) { index += 2; }
      continue;
    }
    if (character === '[') { arrayDepth++; }
    else if (character === ']') { arrayDepth--; }
    else if (character === '{') { objectDepth++; }
    else if (character === '}') { objectDepth--; }
    else if (character === '\n' && arrayDepth === 0 && objectDepth === 0) { finish(index + 1); }
  }
  if (start < text.length) { finish(text.length); }
  return result;
}

interface OwnedBlock { start: number; end: number; parsed: Record<string, unknown>; newline: boolean }

function findOwnedBlock(text: string, name: string): OwnedBlock | undefined {
  const begin = beginMarker(name);
  const end = endMarker(name);
  // Markers must be real comment statements, never text embedded in a string.
  const actual = statements(text).filter(statement => statement.text.trim() === begin || statement.text.trim() === end);
  const starts = actual.filter(statement => statement.text.trim() === begin);
  const ends = actual.filter(statement => statement.text.trim() === end);
  if (starts.length === 0 && ends.length === 0) { return undefined; }
  if (starts.length !== 1 || ends.length !== 1 || starts[0].end > ends[0].start) {
    throw new Error(`Managed profile markers for ${name} are malformed or duplicated. Restore the block before applying changes.`);
  }
  const block = text.slice(starts[0].end, ends[0].start);
  const parsed = parseToml(block, 'Managed profile block');
  const permissions = parsed.permissions as Record<string, unknown> | undefined;
  if (Object.keys(parsed).some(key => key !== 'permissions') || !permissions || Object.keys(permissions).some(key => key !== name)) {
    throw new Error('The managed permission block contains unrelated configuration. Move that configuration outside the markers.');
  }
  return { start: starts[0].start, end: ends[0].end, parsed, newline: ends[0].text.endsWith('\n') };
}

/** Match only real comments inside the validated managed block, never string content. */
export function hasManagedCodexProfileComment(existing: string, name: string, comment: string): boolean {
  const owned = findOwnedBlock(existing, name);
  return !!owned && statements(existing.slice(owned.start, owned.end)).some(statement => statement.text.trim() === comment);
}

function table(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(semanticValue); }
  if (!table(value)) { return value; }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) { result[key] = semanticValue(value[key]); }
  return result;
}

/** Remove only values owned by a block; retain user fields in the same table. */
function outsideOwned(source: Record<string, unknown>, owned: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(owned, key)) { result[key] = semanticValue(source[key]); }
    else if (table(source[key]) && table(owned[key])) {
      const nested = outsideOwned(source[key], owned[key]);
      if (Object.keys(nested).length) { result[key] = nested; }
    }
  }
  return result;
}

function replaceDefault(text: string, name: string, previous: Record<string, unknown>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let tableSeen = false;
  let target: TomlStatement | undefined;
  for (const statement of statements(text)) {
    if (statement.table) { tableSeen = true; }
    if (!tableSeen && statement.assignmentKey === 'default_permissions') { target = statement; break; }
  }
  const selector = `default_permissions = ${quote(name)}`;
  if (target) {
    const comment = target.comment ? ` ${target.comment}` : '';
    const newline = target.text.endsWith('\n') ? eol : '';
    return text.slice(0, target.start) + selector + comment + newline + text.slice(target.end);
  }
  if (Object.hasOwn(previous, 'default_permissions')) {
    throw new Error('Cannot safely locate the existing root default_permissions assignment. Use a simple root-level key before applying.');
  }
  return selector + eol + text;
}

/** Rename only marked AgentScope entries. Unmarked profiles and user table values survive. */
export function removeManagedCodexProfiles(existing: string, replacements: ReadonlyMap<string, string>): string {
  const parsed = parseToml(existing, 'Codex config');
  const blocks: OwnedBlock[] = [];
  const removedPermissions: Record<string, unknown> = Object.create(null);
  let nextDefault: string | undefined;
  for (const [name, replacement] of replacements) {
    checkName(name);
    checkName(replacement);
    const owned = findOwnedBlock(existing, name);
    if (!owned) continue;
    blocks.push(owned);
    Object.assign(removedPermissions, owned.parsed.permissions);
    if (parsed.default_permissions === name) nextDefault = replacement;
  }
  if (!blocks.length) return existing;
  let updated = existing;
  for (const block of blocks.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, block.start) + updated.slice(block.end);
  }
  if (nextDefault !== undefined) updated = replaceDefault(updated, nextDefault, parsed);
  const result = parseToml(updated, 'Migrated Codex config');
  const ignoredDefault = nextDefault === undefined ? {} : { default_permissions: true };
  if (!isDeepStrictEqual(
    outsideOwned(parsed, { permissions: removedPermissions, ...ignoredDefault }),
    outsideOwned(result, ignoredDefault),
  )) {
    throw new Error('Renaming managed profiles would change unrelated TOML configuration or user assignments under a legacy profile. Move those assignments under an explicit user-owned table before applying.');
  }
  return updated;
}

/** Exporting another picker entry must not change the workspace's default profile. */
export function updateCodexConfig(existing: string, profileText: string, profileName: string, selectDefault = true): string {
  checkName(profileName);
  const parsed = parseToml(existing, 'Codex config');
  const legacy = legacySandboxKeys.filter(key => Object.hasOwn(parsed, key));
  if (legacy.length) {
    throw new Error(`Codex config uses legacy sandbox settings (${legacy.join(', ')}). Review and remove them manually before applying a permission profile.`);
  }
  if (Object.hasOwn(parsed, 'default_permissions') && typeof parsed.default_permissions !== 'string') {
    throw new Error('default_permissions must be a root-level profile name string.');
  }
  const supplied = parseToml(profileText, 'New permission profile');
  const profileSet = supplied.permissions as Record<string, unknown> | undefined;
  if (Object.keys(supplied).some(key => key !== 'permissions') || !profileSet || Object.keys(profileSet).length !== 1 || !Object.hasOwn(profileSet, profileName)) {
    throw new Error(`The generated text must contain only the ${profileName} permission profile.`);
  }
  const owned = findOwnedBlock(existing, profileName);
  const existingPermissions = parsed.permissions as Record<string, unknown> | undefined;
  if (!owned && existingPermissions && Object.hasOwn(existingPermissions, profileName)) {
    throw new Error(`The ${profileName} profile is user-owned. Choose a different profile name; AgentScope will not overwrite it.`);
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const cleanProfile = profileText.replace(/\r\n/g, '\n').replace(/\n/g, eol).trimEnd();
  const block = `${beginMarker(profileName)}${eol}${cleanProfile}${eol}${endMarker(profileName)}`;
  // A comment marker does not close a TOML table. Moving this block would
  // reassign later user keys to a different table, even if their bytes survived.
  let updated = owned
    ? existing.slice(0, owned.start) + block + (owned.newline ? eol : '') + existing.slice(owned.end)
    : existing + (existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol) + block + eol;
  if (selectDefault) {
    updated = replaceDefault(updated, profileName, parsed);
  }
  const result = parseToml(updated, 'Updated Codex config');
  const selectedDefault = selectDefault ? { default_permissions: true } : {};
  const previousUserValues = outsideOwned(parsed, { ...owned?.parsed, ...selectedDefault });
  const nextUserValues = outsideOwned(result, { ...supplied, ...selectedDefault });
  if (!isDeepStrictEqual(previousUserValues, nextUserValues)) {
    throw new Error('Updating the managed profile would change unrelated TOML configuration or the table owning a user assignment. Move those assignments under an explicit table before applying.');
  }
  return updated;
}
