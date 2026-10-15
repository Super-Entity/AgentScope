import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertDirectoryIdentity, captureDirectoryIdentity, resolveContained, verifyContained } from './core/paths';
import { ACCESS_POLICY_FILE, readAccessRegistry } from './core/registry';
import { readScopeConfiguration, SCOPE_CONFIGURATION_FILE, writeScopeConfiguration } from './configuration';
import { ApplyPlan, WorkspaceState } from './types';

export interface PolicyCheckpoint {
  version: 2;
  root: string;
  configuration: string;
  savedAt: string;
}
const comparable = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function absoluteRoot(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value !== path.resolve(value)) {
    throw new Error('A configuration checkpoint requires an absolute normalized workspace root.');
  }
  return value;
}
export function checkpointKey(root: string): string {
  return `agentscope.policyCheckpoint.v1.${createHash('sha256').update(comparable(absoluteRoot(root)), 'utf8').digest('hex')}`;
}

/** Older checkpoints import selections only; recovery never reinstalls agent instructions. */
export function validateCheckpoint(value: unknown, root: string): PolicyCheckpoint {
  const expectedRoot = absoluteRoot(root);
  if (!record(value) || comparable(absoluteRoot(value.root)) !== comparable(expectedRoot) || typeof value.savedAt !== 'string'
    || !Number.isFinite(Date.parse(value.savedAt)) || new Date(value.savedAt).toISOString() !== value.savedAt) {
    throw new Error('The saved configuration checkpoint is invalid or belongs to a different workspace.');
  }
  let configuration: string;
  if (value.version === 2 && Object.keys(value).length === 4 && typeof value.configuration === 'string') {
    readScopeConfiguration(value.configuration, root);
    configuration = value.configuration;
  } else if (value.version === 1 && Object.keys(value).length === 5 && typeof value.agents === 'string' && typeof value.access === 'string') {
    const registry = readAccessRegistry(value.agents, value.access);
    if (!registry) throw new Error('The legacy checkpoint has no access selections.');
    for (const module of Object.values(registry.submodules)) module.instruction_file = null;
    configuration = writeScopeConfiguration(null, registry);
    readScopeConfiguration(configuration, root);
  } else throw new Error('The saved configuration checkpoint is incomplete or has an unsupported format.');
  return { version: 2, root: expectedRoot, configuration, savedAt: value.savedAt };
}

export function createCheckpoint(state: WorkspaceState): PolicyCheckpoint | null {
  try {
    if (state.dirty || !state.files) return null;
    const configuration = state.files[resolveContained(state.root, SCOPE_CONFIGURATION_FILE)];
    if (typeof configuration !== 'string') return null;
    return validateCheckpoint({ version: 2, root: state.root, configuration, savedAt: new Date().toISOString() }, state.root);
  } catch { return null; }
}

export function checkpointFromLastApply(root: string, value: unknown): PolicyCheckpoint | null {
  try {
    absoluteRoot(root);
    if (!Array.isArray(value) || !value.length) return null;
    const allowed = new Set(['AGENTS.md', ACCESS_POLICY_FILE, SCOPE_CONFIGURATION_FILE, '.vscode/settings.json', '.codex/config.toml'].map(relative => comparable(resolveContained(root, relative))));
    const outputs = new Map<string, string>();
    for (const item of value) {
      if (!record(item) || Object.keys(item).length !== 3 || typeof item.path !== 'string' || !path.isAbsolute(item.path)
        || item.path !== path.resolve(item.path) || !allowed.has(comparable(item.path)) || outputs.has(comparable(item.path))
        || (item.before !== null && typeof item.before !== 'string') || typeof item.after !== 'string') return null;
      outputs.set(comparable(item.path), item.after);
    }
    const configuration = outputs.get(comparable(resolveContained(root, SCOPE_CONFIGURATION_FILE)));
    return validateCheckpoint(configuration !== undefined
      ? { version: 2, root, configuration, savedAt: new Date().toISOString() }
      : { version: 1, root, agents: outputs.get(comparable(resolveContained(root, 'AGENTS.md'))), access: outputs.get(comparable(resolveContained(root, ACCESS_POLICY_FILE))), savedAt: new Date().toISOString() }, root);
  } catch { return null; }
}

export async function buildPolicyRecoveryPlan(root: string, value: PolicyCheckpoint): Promise<ApplyPlan> {
  const checkpoint = validateCheckpoint(value, root);
  if (comparable(await fs.realpath(root)) !== comparable(root)) throw new Error('The workspace root changed; select it again before recovering configuration.');
  const identity = await captureDirectoryIdentity(root);
  const target = resolveContained(root, SCOPE_CONFIGURATION_FILE);
  if (comparable(await verifyContained(root, target)) !== comparable(target)) throw new Error('Refusing a symbolic link or junction in a configuration recovery path.');
  try {
    const parent = await fs.lstat(path.dirname(target));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('Configuration recovery parent must be an ordinary directory.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let before: string | null = null;
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Configuration recovery target must be a regular file.');
    before = await fs.readFile(target, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await assertDirectoryIdentity(root, identity);
  return {
    changes: before === checkpoint.configuration ? [] : [{ path: target, before, after: checkpoint.configuration }], warnings: [],
    checks: [{ path: target, expected: before }], directoryChecks: [{ path: root, identity }],
    pathChecks: [root, path.dirname(target), target].map(targetPath => ({ root, path: targetPath, resolved: targetPath })),
  };
}
