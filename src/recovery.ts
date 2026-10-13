import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertDirectoryIdentity, captureDirectoryIdentity, resolveContained, verifyContained } from './core/paths';
import { ACCESS_POLICY_FILE, isAccessReference, readAccessRegistry, validateRegistry } from './core/registry';
import { ApplyPlan, FileChange, WorkspaceState } from './types';

/** Stored by the host outside the workspace policy files; never a draft. */
export interface PolicyCheckpoint {
  version: 1;
  root: string;
  agents: string;
  access: string;
  savedAt: string;
}

const policyFiles = ['AGENTS.md', ACCESS_POLICY_FILE] as const;
const generatedFiles = [...policyFiles, '.vscode/settings.json', '.codex/config.toml'];

function comparable(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function absoluteRoot(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value !== path.resolve(value)) {
    throw new Error('A policy checkpoint requires an absolute normalized workspace root.');
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** The root supplied by the host must already be canonical, as in WorkspaceState. */
export function checkpointKey(root: string): string {
  const normalized = absoluteRoot(root);
  const digest = createHash('sha256').update(comparable(normalized), 'utf8').digest('hex');
  return `agentscope.policyCheckpoint.v1.${digest}`;
}

/** Memento data is untrusted. Only complete, valid, explicitly linked policy pairs are restorable. */
export function validateCheckpoint(value: unknown, root: string): PolicyCheckpoint {
  const expectedRoot = absoluteRoot(root);
  if (!record(value) || Object.keys(value).length !== 5
    || !['version', 'root', 'agents', 'access', 'savedAt'].every(key => Object.hasOwn(value, key))
    || value.version !== 1 || typeof value.agents !== 'string' || !value.agents.trim()
    || typeof value.access !== 'string' || !value.access.trim() || typeof value.savedAt !== 'string') {
    throw new Error('The saved policy checkpoint is incomplete or has an unsupported format.');
  }
  const savedRoot = absoluteRoot(value.root);
  if (comparable(savedRoot) !== comparable(expectedRoot)) {
    throw new Error('The saved policy checkpoint belongs to a different workspace.');
  }
  const savedTime = new Date(value.savedAt);
  if (!Number.isFinite(savedTime.valueOf()) || savedTime.toISOString() !== value.savedAt) {
    throw new Error('The saved policy checkpoint has an invalid timestamp.');
  }
  if (!isAccessReference(value.agents)) {
    throw new Error('The saved AGENTS.md does not contain a valid AgentScope access reference.');
  }
  const registry = readAccessRegistry(value.agents, value.access);
  if (registry === null) throw new Error('The saved access policy does not contain a registry.');
  validateRegistry(registry, expectedRoot);
  return {
    version: 1, root: expectedRoot, agents: value.agents, access: value.access, savedAt: value.savedAt,
  };
}

/** Missing, conflicting or malformed files never replace the host's last good checkpoint. */
export function createCheckpoint(state: WorkspaceState): PolicyCheckpoint | null {
  try {
    if (state.dirty || !state.files) return null;
    const root = absoluteRoot(state.root);
    const agentsPath = resolveContained(root, policyFiles[0]);
    const accessPath = resolveContained(root, policyFiles[1]);
    if (!Object.hasOwn(state.files, agentsPath) || !Object.hasOwn(state.files, accessPath)) return null;
    return validateCheckpoint({
      version: 1, root,
      agents: state.files[agentsPath], access: state.files[accessPath], savedAt: new Date().toISOString(),
    }, root);
  } catch { return null; }
}

/** Bootstrap an older installation only from two complete outputs of the same successful Apply. */
export function checkpointFromLastApply(root: string, value: unknown): PolicyCheckpoint | null {
  try {
    absoluteRoot(root);
    if (!Array.isArray(value)) return null;
    const allowed = new Map(generatedFiles.map(relative => [comparable(resolveContained(root, relative)), relative]));
    const seen = new Set<string>();
    const outputs = new Map<string, string>();
    for (const item of value) {
      if (!record(item) || Object.keys(item).length !== 3
        || !['path', 'before', 'after'].every(key => Object.hasOwn(item, key))
        || typeof item.path !== 'string' || !path.isAbsolute(item.path)
        || /[\x00-\x1f\x7f]/.test(item.path) || item.path !== path.resolve(item.path)
        || (item.before !== null && typeof item.before !== 'string') || typeof item.after !== 'string') return null;
      const key = comparable(item.path);
      const relative = allowed.get(key);
      if (!relative || seen.has(key)) return null;
      seen.add(key);
      outputs.set(relative, item.after);
    }
    if (!outputs.has(policyFiles[0]) || !outputs.has(policyFiles[1])) return null;
    return validateCheckpoint({
      version: 1, root, agents: outputs.get(policyFiles[0]), access: outputs.get(policyFiles[1]),
      savedAt: new Date().toISOString(),
    }, root);
  } catch { return null; }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** The exact policy targets may be absent, but configuration links and directories are never followed. */
async function readPolicyTarget(root: string, relative: string): Promise<{ path: string; text: string | null }> {
  const target = resolveContained(root, relative);
  const resolved = await verifyContained(root, target);
  if (comparable(resolved) !== comparable(target)) {
    throw new Error(`Refusing a symbolic link or junction in a policy recovery path: ${relative}`);
  }
  const parent = path.dirname(target);
  try {
    const info = await fs.lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Policy recovery parent must be an ordinary directory: ${relative}`);
    }
  } catch (error) { if (!missing(error)) throw error; }
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Policy recovery target must be a regular file: ${relative}`);
    }
    return { path: target, text: await fs.readFile(target, 'utf8') };
  } catch (error) { if (missing(error)) return { path: target, text: null }; throw error; }
}

/** Restore exact saved bytes, with every current policy input guarded against competing edits. */
export async function buildPolicyRecoveryPlan(root: string, value: PolicyCheckpoint): Promise<ApplyPlan> {
  const checkpoint = validateCheckpoint(value, root);
  const canonicalRoot = await fs.realpath(root);
  if (comparable(canonicalRoot) !== comparable(root) || !(await fs.lstat(root)).isDirectory()) {
    throw new Error('The workspace root changed or is not an ordinary directory; select it again before recovering policies.');
  }
  const identity = await captureDirectoryIdentity(root);
  const [agents, access] = await Promise.all(policyFiles.map(relative => readPolicyTarget(root, relative)));
  const changes: FileChange[] = [];
  // Install the policy before installing the instructions that refer to it.
  for (const [input, replacement] of [[access, checkpoint.access], [agents, checkpoint.agents]] as const) {
    if (input.text !== replacement) changes.push({ path: input.path, before: input.text, after: replacement });
  }
  await assertDirectoryIdentity(root, identity);
  return {
    changes,
    warnings: [],
    directoryChecks: [{ path: root, identity }],
    checks: [agents, access].map(input => ({ path: input.path, expected: input.text })),
    pathChecks: [root, path.dirname(access.path), agents.path, access.path].map(target => ({
      root, path: target, resolved: target,
    })),
  };
}
