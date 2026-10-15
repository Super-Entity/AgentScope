import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { updateExcludesSettings } from './core/excludes';
import { assertDirectoryIdentity, captureDirectoryIdentity, ContainedResolver, createContainedResolver, normalizeRelative, resolveContained, verifyContained } from './core/paths';
import { generateProfile, updateCodexConfig } from './core/profile';
import { CodexFilesystemMode, CodexRuntime, runtimeWorkspaceRoot } from './core/runtimePaths';
import { ACCESS_POLICY_FILE, emptyRegistry, parseGitmodules, parseJsoncStrict, readAccessRegistry, readAgentsRegistry, validateRegistry, writeAccessFiles, writeReconfiguredAccessFiles } from './core/registry';
import { ApplyPlan, DiscoveredModule, FileChange, ModuleConfig, Registry, WorkspaceState } from './types';
import { isResourcePath } from './resources';

export interface ApplyOptions {
  generateCodexProfile: boolean;
  profileName: string;
  excludeFromSearch: boolean;
  allowNetwork: boolean;
  codexRuntime?: CodexRuntime;
  codexWorkspaceRoot?: string;
  codexFilesystemMode?: CodexFilesystemMode;
}

const agentsFile = 'AGENTS.md';
const gitmodulesFile = '.gitmodules';
const settingsFile = '.vscode/settings.json';
const codexFile = '.codex/config.toml';

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function comparable(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function overlaps(first: string, second: string): boolean { return contained(first, second) || contained(second, first); }

function rejectMetadataScope(root: string, target: string): void {
  const relative = normalizeRelative(path.relative(root, target) || '.');
  const segments = process.platform === 'win32' ? relative.toLowerCase().split('/') : relative.split('/');
  if (segments.includes('.git')) throw new Error(`Project-content access cannot grant Git metadata: ${relative}`);
}

/** Configuration writes never traverse a file link or a linked configuration directory. */
async function configurationPath(root: string, relative: string, resolver?: ContainedResolver): Promise<string> {
  const target = resolveContained(root, relative);
  const canonical = resolver ? await resolver.resolve(target) : await verifyContained(root, target);
  if (comparable(target) !== comparable(canonical)) {
    throw new Error(`Refusing a symbolic link or junction in a configuration path: ${relative}`);
  }
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Configuration target must be a regular file: ${relative}`);
  } catch (error) { if (!missing(error)) throw error; }
  return canonical;
}

async function readOptional(target: string): Promise<string | null> {
  try { return await fs.readFile(target, 'utf8'); }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function readConfiguration(root: string, relative: string, resolver: ContainedResolver): Promise<{ path: string; text: string | null }> {
  const target = await configurationPath(root, relative, resolver);
  return { path: target, text: await readOptional(target) };
}

async function readWorkspaceConfiguration(root: string): Promise<Array<{ path: string; text: string | null }>> {
  const resolver = await createContainedResolver(root);
  const files = await Promise.all([
    readConfiguration(root, agentsFile, resolver),
    readConfiguration(root, ACCESS_POLICY_FILE, resolver),
    readConfiguration(root, gitmodulesFile, resolver),
    readConfiguration(root, settingsFile, resolver),
  ]);
  await resolver.assertUnchanged();
  return files;
}

function settingsExclusions(settings: string | null): Record<string, unknown> | undefined {
  if (!settings?.trim()) return undefined;
  const value = parseJsoncStrict(settings, 'VS Code settings');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VS Code settings must be a JSON/JSONC object.');
  const excludes = (value as Record<string, unknown>)['files.exclude'];
  if (excludes === undefined) return undefined;
  if (!excludes || typeof excludes !== 'object' || Array.isArray(excludes)) throw new Error('files.exclude must be an object of exclusion patterns.');
  return excludes as Record<string, unknown>;
}

function exactHidden(excludes: Record<string, unknown> | undefined, module: ModuleConfig): boolean {
  const relative = normalizeRelative(module.path);
  return relative !== '.' && excludes?.[relative] === true;
}

function resourceVisibility(excludes: Record<string, unknown> | undefined, registry: Registry): Record<string, boolean> {
  const hidden: Record<string, boolean> = Object.create(null);
  if (excludes === undefined) return hidden;
  for (const [literal, choice] of Object.entries(excludes)) {
    if (typeof choice !== 'boolean') continue;
    try {
      const relative = normalizeRelative(literal);
      // Preserve patterns and noncanonical spellings as unrelated editor settings.
      if (relative === literal && isResourcePath(registry, relative)) hidden[relative] = choice;
    } catch { /* A glob or another editor-specific pattern is not a literal resource path. */ }
  }
  return hidden;
}

const rootProjectMarkers = new Set([
  '.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'composer.json', 'Gemfile', 'mix.exs', 'pubspec.yaml', 'CMakeLists.txt', 'Makefile',
]);
const generatedDirectories = new Set(['node_modules', '__pycache__']);
const reservedProjectNames = new Set(['__proto__', 'prototype', 'constructor']);

function disabledProject(relative: string): ModuleConfig {
  return { path: relative, enabled: false, restrict_paths: true, read_paths: [], write_paths: [], instruction_file: null };
}

/** Initial registration uses root entry names only; it never opens or recurses into project content. */
async function discoverOrdinaryProjects(root: string, warnings: string[]): Promise<DiscoveredModule[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const rootProject = entries.some(entry => rootProjectMarkers.has(entry.name)
    || /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(entry.name));
  const projects: DiscoveredModule[] = [];
  if (!rootProject) {
    const names = new Set<string>();
    for (const entry of entries.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || generatedDirectories.has(entry.name)) continue;
      let relative: string;
      try {
        relative = normalizeRelative(entry.name);
        if (relative !== entry.name) throw new Error('the directory name is not a canonical scope path');
      } catch (error) {
        warnings.push(`${entry.name}: initial folder discovery skipped an unsupported scope path (${(error as Error).message}).`);
        continue;
      }
      const base = reservedProjectNames.has(entry.name) ? `${entry.name} project` : entry.name;
      let name = base;
      for (let suffix = 2; names.has(name); suffix++) name = `${base} (${suffix})`;
      names.add(name);
      projects.push({ name, path: relative });
    }
  }
  if (projects.length === 0) {
    let name = path.basename(root) || 'Workspace';
    if (reservedProjectNames.has(name)) name = 'Workspace';
    projects.push({ name, path: '.' });
  }
  return projects;
}

/** Read configuration and, only without saved registration, enumerate immediate ordinary folders. */
export async function loadWorkspace(root: string): Promise<WorkspaceState> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const rootIdentity = await captureDirectoryIdentity(canonicalRoot);
  const [agents, access, gitmodules, settings] = await readWorkspaceConfiguration(canonicalRoot);
  const existingRegistry = readAccessRegistry(agents.text ?? '', access.text);
  const registry = existingRegistry ?? emptyRegistry();
  const discovered = parseGitmodules(gitmodules.text ?? '');
  const warnings: string[] = [];
  if (agents.text === null && access.text !== null) {
    warnings.push('AGENTS.md is missing. Apply will recreate its access reference; saved access settings are preserved.');
  }
  if (existingRegistry === null && discovered.length === 0) {
    for (const module of await discoverOrdinaryProjects(canonicalRoot, warnings)) {
      registry.submodules[module.name] = disabledProject(module.path);
    }
  }
  for (const module of discovered) {
    if (['__proto__', 'prototype', 'constructor'].includes(module.name)) throw new Error(`Unsupported submodule name: ${module.name}`);
    if (Object.hasOwn(registry.submodules, module.name)) {
      if (normalizeRelative(registry.submodules[module.name].path) !== normalizeRelative(module.path)) {
        warnings.push(`${module.name}: the registry path differs from .gitmodules; the existing registry was preserved.`);
      }
      continue;
    }
    const existing = Object.entries(registry.submodules).find(([, entry]) => normalizeRelative(entry.path) === normalizeRelative(module.path));
    if (existing) {
      warnings.push(`${module.path}: .gitmodules uses the name ${module.name}; registry entry ${existing[0]} was preserved.`);
      continue;
    }
    const intersecting = Object.entries(registry.submodules).find(([, entry]) => overlaps(
      resolveContained(canonicalRoot, entry.path), resolveContained(canonicalRoot, module.path),
    ));
    if (intersecting) {
      warnings.push(`${module.path}: discovery overlaps existing project ${intersecting[0]}; its configured scope was preserved. Remove or narrow that project to manage this submodule separately.`);
      continue;
    }
    registry.submodules[module.name] = {
      path: module.path, enabled: false, restrict_paths: true,
      read_paths: [], write_paths: [], instruction_file: null,
    };
  }
  validateRegistry(registry, canonicalRoot);
  const excludes = settingsExclusions(settings.text);
  const hidden: Record<string, boolean> = {};
  for (const [name, module] of Object.entries(registry.submodules)) hidden[name] = exactHidden(excludes, module);
  await assertDirectoryIdentity(canonicalRoot, rootIdentity);
  return {
    root: canonicalRoot, rootIdentity, registry, hidden, resourceHidden: resourceVisibility(excludes, registry), dirty: false, warnings,
    files: { [agents.path]: agents.text, [access.path]: access.text, [gitmodules.path]: gitmodules.text, [settings.path]: settings.text },
  };
}

/**
 * Explicit repair draft: configuration bytes are snapshotted, while healthy
 * registration metadata only identifies project roots. No previous grant is reused.
 */
export async function loadWorkspaceForReconfiguration(root: string, registrationRegistry?: Registry): Promise<WorkspaceState> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const rootIdentity = await captureDirectoryIdentity(canonicalRoot);
  const [agents, access, gitmodules, settings] = await readWorkspaceConfiguration(canonicalRoot);
  const registry = emptyRegistry();
  const warnings = ['Access reconfiguration is a draft. All previous Read and Write choices have been cleared; select the intended scopes and Apply to rebuild the policy.'];
  const registrations: Array<{ label: string; modules: DiscoveredModule[] }> = [];
  if (registrationRegistry) {
    validateRegistry(registrationRegistry, canonicalRoot);
    registrations.push({ label: 'saved workspace registration', modules: Object.entries(registrationRegistry.submodules).map(([name, module]) => ({ name, path: module.path })) });
  }
  for (const [label, read] of [
    ['AGENTS.md', () => readAgentsRegistry(agents.text ?? '')],
    [ACCESS_POLICY_FILE, () => access.text === null ? null : readAccessRegistry('', access.text)],
  ] as const) {
    try {
      const candidate = read();
      if (candidate) {
        validateRegistry(candidate, canonicalRoot);
        registrations.push({ label, modules: Object.entries(candidate.submodules).map(([name, module]) => ({ name, path: module.path })) });
      }
    } catch (error) {
      warnings.push(`${label}: damaged policy data was ignored for registration (${(error as Error).message}); no access was inferred.`);
    }
  }
  registrations.push({ label: '.gitmodules', modules: parseGitmodules(gitmodules.text ?? '') });
  for (const source of registrations) {
    for (const module of source.modules) {
      const relative = normalizeRelative(module.path);
      const existing = registry.submodules[module.name];
      if (existing) {
        if (comparable(resolveContained(canonicalRoot, existing.path)) !== comparable(resolveContained(canonicalRoot, relative))) {
          throw new Error(`Ambiguous project registration for ${module.name}: ${existing.path} / ${relative} (${source.label}). Review the project roots before reconfiguring access.`);
        }
        continue;
      }
      const sameRoot = Object.entries(registry.submodules).find(([, entry]) => comparable(resolveContained(canonicalRoot, entry.path)) === comparable(resolveContained(canonicalRoot, relative)));
      if (sameRoot) {
        warnings.push(`${relative}: retained project name ${sameRoot[0]} instead of duplicate name ${module.name} from ${source.label}.`);
        continue;
      }
      const intersection = Object.entries(registry.submodules).find(([, entry]) => overlaps(resolveContained(canonicalRoot, entry.path), resolveContained(canonicalRoot, relative)));
      if (intersection) throw new Error(`Ambiguous overlapping project roots: ${intersection[1].path} / ${relative} (${source.label}). Review the registrations before reconfiguring access.`);
      registry.submodules[module.name] = {
        path: relative, enabled: false, restrict_paths: true,
        read_paths: [], write_paths: [], instruction_file: null,
      };
    }
  }
  if (Object.keys(registry.submodules).length === 0) {
    for (const module of await discoverOrdinaryProjects(canonicalRoot, warnings)) {
      registry.submodules[module.name] = disabledProject(module.path);
    }
  }
  validateRegistry(registry, canonicalRoot);
  const excludes = settingsExclusions(settings.text);
  const hidden: Record<string, boolean> = {};
  for (const [name, module] of Object.entries(registry.submodules)) hidden[name] = exactHidden(excludes, module);
  await assertDirectoryIdentity(canonicalRoot, rootIdentity);
  return {
    root: canonicalRoot, rootIdentity, registry, hidden, resourceHidden: resourceVisibility(excludes, registry),
    dirty: true, reconfigurePolicy: true, warnings,
    files: { [agents.path]: agents.text, [access.path]: access.text, [gitmodules.path]: gitmodules.text, [settings.path]: settings.text },
  };
}

interface VerifiedScopes {
  moduleRoots: Map<string, string>;
  readable: Array<{ lexical: string; canonical: string }>;
  pathChecks: NonNullable<ApplyPlan['pathChecks']>;
}

/** Check configured scope links against their actual anchors, including disabled project boundaries. */
async function verifyScopes(root: string, registry: Registry): Promise<VerifiedScopes> {
  const moduleRoots = new Map<string, string>();
  const readable: Array<{ lexical: string; canonical: string }> = [];
  const pathChecks: NonNullable<ApplyPlan['pathChecks']> = [{ root, path: root, resolved: root }];
  const checkKey = (anchor: string, target: string): string => `${comparable(anchor)}\u0000${comparable(target)}`;
  const checkedPaths = new Set([checkKey(root, root)]);
  const resolutions = new Map<string, Promise<string>>();
  // A planning pass can see the same literal path in Read, Write and instructions.
  // Reuse it only in this pass; transaction guards still resolve every retained check afresh.
  const verify = (anchor: string, target: string): Promise<string> => {
    const key = checkKey(anchor, target);
    let resolution = resolutions.get(key);
    if (!resolution) {
      resolution = verifyContained(anchor, target);
      resolutions.set(key, resolution);
    }
    return resolution;
  };
  const addCheck = (anchor: string, target: string, resolved: string): void => {
    const key = checkKey(anchor, target);
    if (checkedPaths.has(key)) return;
    checkedPaths.add(key);
    pathChecks.push({ root: anchor, path: target, resolved });
  };
  const entries = Object.entries(registry.submodules);
  for (const [name, module] of entries) {
    try {
      const lexical = resolveContained(root, module.path);
      const canonical = await verify(root, lexical);
      moduleRoots.set(name, canonical);
      addCheck(root, lexical, canonical);
    }
    catch (error) { if (module.enabled) throw error; }
  }
  for (const [name, module] of entries) {
    if (!module.enabled) continue;
    const actualRoot = moduleRoots.get(name)!;
    rejectMetadataScope(root, actualRoot);
    for (const [otherName, otherRoot] of moduleRoots) {
      if (name !== otherName && overlaps(actualRoot, otherRoot)) {
        throw new Error(`A project root crosses another registered project through a link: ${name} / ${otherName}`);
      }
    }
    const lexicalRoot = resolveContained(root, module.path);
    const scopes = module.restrict_paths ? [...new Set([...module.read_paths, ...module.write_paths].map(normalizeRelative))] : ['.'];
    for (const relative of scopes) {
      const lexical = resolveContained(lexicalRoot, relative);
      const canonical = await verify(lexicalRoot, lexical);
      rejectMetadataScope(root, lexical);
      rejectMetadataScope(root, canonical);
      for (const [otherName, otherRoot] of moduleRoots) {
        if (name !== otherName && overlaps(canonical, otherRoot)) {
          throw new Error(`A project scope crosses another registered project through a link: ${name}: ${relative}`);
        }
      }
      readable.push({ lexical, canonical });
      addCheck(lexicalRoot, lexical, canonical);
    }
  }
  for (const relative of new Set([...registry.shared_resources.read_paths, ...registry.shared_resources.write_paths].map(normalizeRelative))) {
    const lexical = resolveContained(root, relative);
    const canonical = await verify(root, lexical);
    rejectMetadataScope(root, lexical);
    rejectMetadataScope(root, canonical);
    for (const [name, moduleRoot] of moduleRoots) {
      if (overlaps(canonical, moduleRoot)) throw new Error(`A shared resource enters a registered project through a link: ${relative} / ${name}`);
    }
    readable.push({ lexical, canonical });
    addCheck(root, lexical, canonical);
  }
  for (const [name, module] of entries) {
    if (!module.enabled || module.instruction_file === null) continue;
    const lexical = resolveContained(root, module.instruction_file);
    const canonical = await verify(root, lexical);
    const accessible = readable.some(scope => contained(scope.lexical, lexical) && contained(scope.canonical, canonical));
    if (!accessible) throw new Error(`${name}: the selected instruction resolves outside its readable scope.`);
    let info;
    try { info = await fs.stat(canonical); }
    catch (error) {
      if (missing(error)) throw new Error(`${name}: the selected instruction_file does not exist: ${module.instruction_file}`);
      throw error;
    }
    if (!info.isFile()) throw new Error(`${name}: the selected instruction_file is not a file.`);
    addCheck(root, lexical, canonical);
  }
  return { moduleRoots, readable, pathChecks };
}

async function verifiedGitPaths(
  root: string, registry: Registry, discovered: DiscoveredModule[], roots: Map<string, string>, warnings: string[],
): Promise<{ read: string[]; write: string[]; checks: NonNullable<ApplyPlan['checks']>; pathChecks: NonNullable<ApplyPlan['pathChecks']> }> {
  const read = new Set<string>();
  const write = new Set<string>();
  const checks: NonNullable<ApplyPlan['checks']> = [];
  const pathChecks: NonNullable<ApplyPlan['pathChecks']> = [];
  for (const [name, module] of Object.entries(registry.submodules)) {
    if (!module.enabled) continue;
    const hasRead = !module.restrict_paths || module.read_paths.length > 0 || module.write_paths.length > 0;
    if (!hasRead) continue;
    const moduleRoot = roots.get(name)!;
    const pointer = path.join(moduleRoot, '.git');
    let info;
    try { info = await fs.lstat(pointer); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (info.isSymbolicLink()) {
      warnings.push(`${name}: linked .git was skipped; no metadata access was added.`);
      continue;
    }
    let metadata: string;
    let pointerText: string | undefined;
    let ownershipRoot: string | undefined;
    try {
      await verifyContained(moduleRoot, pointer);
      if (info.isDirectory()) {
        metadata = await verifyContained(moduleRoot, pointer);
      } else if (info.isFile()) {
        const text = await fs.readFile(pointer, 'utf8');
        pointerText = text;
        const match = /^gitdir:[ \t]+([^\r\n]+)(?:\r?\n)?$/i.exec(text);
        if (!match) throw new Error('the .git file is not a valid Git directory pointer');
        const candidate = path.resolve(moduleRoot, match[1].trim());
        if (contained(moduleRoot, candidate)) {
          // An internal pointer is not itself authorization for ordinary content.
          // Only a dedicated .git subtree can receive implicit metadata grants.
          const relative = path.relative(moduleRoot, candidate);
          const parts = relative.split(path.sep);
          const metadataIndex = parts.findIndex(part => process.platform === 'win32' ? part.toLowerCase() === '.git' : part === '.git');
          if (metadataIndex < 0) throw new Error('the internal pointer targets project content instead of a dedicated .git directory');
          const metadataRoot = path.resolve(moduleRoot, ...parts.slice(0, metadataIndex + 1));
          const canonicalMetadataRoot = await verifyContained(moduleRoot, metadataRoot);
          if (comparable(metadataRoot) !== comparable(canonicalMetadataRoot)) {
            throw new Error('the internal metadata root is redirected through a link');
          }
          ownershipRoot = metadataRoot;
          metadata = await verifyContained(metadataRoot, candidate);
        } else {
          // Git's registered name can differ from its folder or the registry's display name.
          const registered = discovered.find(entry => normalizeRelative(entry.path) === normalizeRelative(module.path));
          if (!registered) throw new Error('the external metadata path has no matching registered submodule');
          const metadataRoot = resolveContained(resolveContained(root, '.git/modules'), registered.name);
          ownershipRoot = metadataRoot;
          if (!contained(metadataRoot, candidate)) throw new Error('the pointer leaves this submodule\'s own metadata directory');
          const canonicalMetadataRoot = await verifyContained(root, metadataRoot);
          if (comparable(metadataRoot) !== comparable(canonicalMetadataRoot)) {
            throw new Error('the registered metadata root is redirected through a link');
          }
          metadata = await verifyContained(metadataRoot, candidate);
        }
        if (!(await fs.stat(metadata)).isDirectory()) throw new Error('the Git metadata destination is not a directory');
        read.add(pointer);
      } else { throw new Error('the .git entry is not a regular file or directory'); }
      read.add(metadata);
      if (!module.restrict_paths || module.write_paths.length > 0) write.add(metadata);
      if (pointerText !== undefined) checks.push({ path: pointer, expected: pointerText });
      pathChecks.push({ root, path: metadata, resolved: metadata });
      if (ownershipRoot) pathChecks.push({ root, path: ownershipRoot, resolved: ownershipRoot });
    } catch (error) {
      warnings.push(`${name}: Git metadata was skipped (${(error as Error).message}); no metadata access was added.`);
    }
  }
  return { read: [...read], write: [...write], checks, pathChecks };
}

async function expectedConfiguration(state: WorkspaceState, relative: string, resolver: ContainedResolver): Promise<{ path: string; before: string | null }> {
  const target = await configurationPath(state.root, relative, resolver);
  if (state.files && Object.hasOwn(state.files, target)) return { path: target, before: state.files[target] };
  const before = await readOptional(target);
  state.files ??= {};
  state.files[target] = before;
  return { path: target, before };
}

/** Compute all output text first. Any invalid registry/profile aborts without writing files. */
export async function buildApplyPlan(state: WorkspaceState, options: ApplyOptions): Promise<ApplyPlan> {
  const rootIdentity = state.rootIdentity ??= await captureDirectoryIdentity(state.root);
  await assertDirectoryIdentity(state.root, rootIdentity);
  if (comparable(await fs.realpath(state.root)) !== comparable(state.root)) throw new Error('Workspace root changed since it was loaded; refresh before applying.');
  validateRegistry(state.registry, state.root);
  const scopes = await verifyScopes(state.root, state.registry);
  const warnings = [...state.warnings];
  const changes: FileChange[] = [];
  let broadReadAccess = false;
  const checks: NonNullable<ApplyPlan['checks']> = [];
  const pathChecks = [...scopes.pathChecks];
  const configResolver = await createContainedResolver(state.root);
  const agents = await expectedConfiguration(state, agentsFile, configResolver);
  const access = await expectedConfiguration(state, ACCESS_POLICY_FILE, configResolver);
  const settings = await expectedConfiguration(state, settingsFile, configResolver);
  const nextPolicy = state.reconfigurePolicy
    ? writeReconfiguredAccessFiles(agents.before ?? '', state.registry)
    : writeAccessFiles(agents.before ?? '', access.before, state.registry);
  warnings.push(...nextPolicy.warnings);
  const hiddenByPath: Record<string, boolean> = Object.create(null);
  for (const [name, module] of Object.entries(state.registry.submodules)) {
    if (normalizeRelative(module.path) !== '.') hiddenByPath[module.path] = state.hidden[name] === true;
  }
  const visiblePaths = Object.values(state.registry.submodules).map(module => module.path).filter(modulePath => normalizeRelative(modulePath) !== '.');
  for (const [literal, hidden] of Object.entries(state.resourceVisibilityChanges ?? {})) {
    const relative = normalizeRelative(literal);
    if (typeof hidden !== 'boolean' || !isResourcePath(state.registry, relative)) {
      throw new Error(`Invalid workspace resource visibility path: ${literal}`);
    }
    const target = resolveContained(state.root, relative);
    const canonical = await verifyContained(state.root, target);
    rejectMetadataScope(state.root, canonical);
    for (const [name, moduleRoot] of scopes.moduleRoots) {
      if (overlaps(canonical, moduleRoot)) { throw new Error(`Workspace resource visibility enters a registered project through a link: ${relative} / ${name}`); }
    }
    pathChecks.push({ root: state.root, path: target, resolved: canonical });
    hiddenByPath[relative] = hidden;
    visiblePaths.push(relative);
  }
  const nextSettings = visiblePaths.length > 0
    ? updateExcludesSettings(settings.before ?? '', visiblePaths, hiddenByPath, options.excludeFromSearch)
    : settings.before;
  // Create/update the policy before publishing its reference in AGENTS.md.
  if (nextPolicy.access !== access.before) changes.push({ ...access, after: nextPolicy.access });
  if (nextPolicy.agents !== agents.before) changes.push({ ...agents, after: nextPolicy.agents });
  if (nextSettings !== settings.before && nextSettings !== null) changes.push({ ...settings, after: nextSettings });
  const manifest = await expectedConfiguration(state, gitmodulesFile, configResolver);
  checks.push({ path: manifest.path, expected: manifest.before });
  if (options.generateCodexProfile) {
    const discovered = parseGitmodules(manifest.before ?? '');
    const git = await verifiedGitPaths(state.root, state.registry, discovered, scopes.moduleRoots, warnings);
    checks.push(...git.checks);
    pathChecks.push(...git.pathChecks);
    const profile = generateProfile(state.registry, {
      root: state.root, runtimeRoot: runtimeWorkspaceRoot(state.root, options.codexRuntime, options.codexWorkspaceRoot),
      profileName: options.profileName, allowNetwork: options.allowNetwork,
      filesystemMode: options.codexFilesystemMode,
      gitReadPaths: git.read, gitWritePaths: git.write,
    });
    broadReadAccess = profile.broadReadAccess;
    warnings.push(...profile.warnings);
    const config = await expectedConfiguration(state, codexFile, configResolver);
    const nextConfig = updateCodexConfig(config.before ?? '', profile.text, options.profileName);
    if (nextConfig !== config.before) changes.push({ ...config, after: nextConfig });
    else checks.push({ path: config.path, expected: config.before });
  }
  for (const input of [agents, access, settings]) {
    if (!changes.some(change => comparable(change.path) === comparable(input.path))) {
      checks.push({ path: input.path, expected: input.before });
    }
  }
  // Every destination was checked, including parent junctions, before returning the plan.
  await configResolver.assertUnchanged();
  await assertDirectoryIdentity(state.root, rootIdentity);
  return { changes, warnings: [...new Set(warnings)], broadReadAccess, checks, pathChecks, directoryChecks: [{ path: state.root, identity: rootIdentity }] };
}
