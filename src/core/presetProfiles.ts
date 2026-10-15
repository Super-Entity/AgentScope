import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as TOML from '@iarna/toml';
import type { ProfileOptions, Registry } from '../types';
import { generateProfile, updateCodexConfig } from './profile';
import { resolveFilesystemMode, runtimeWorkspaceRoot } from './runtimePaths';

export interface PresetProfileInput {
  name: string;
  registry: Registry;
  /** Runtime and exact Git grants must be verified by the workspace layer. */
  options: Omit<ProfileOptions, 'profileName' | 'description'>;
}

export interface ExportedPresetProfile {
  presetName: string;
  profileName: string;
  description: string;
  broadReadAccess: boolean;
  runtimeRoot: string;
}

export interface PresetProfilesOutput {
  text: string;
  profiles: ExportedPresetProfile[];
  warnings: string[];
  broadReadAccess: boolean;
}

/** Names remain distinct even when case, punctuation or non-Latin text share a slug.
 * A semantic revision makes published entries immutable when a preset is edited.
 */
export function presetProfileName(name: string, revision?: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 80 || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('A preset profile requires a name of 1–80 characters without surrounding whitespace or control characters.');
  }
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'preset';
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);
  if (revision !== undefined && typeof revision !== 'string') { throw new Error('A preset profile revision must be a string.'); }
  const suffix = revision === undefined ? '' : `-${createHash('sha256').update(revision, 'utf8').digest('hex').slice(0, 12)}`;
  return `agentscope-preset-${slug}-${hash}${suffix}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key]);
  return result;
}

/** Publish all presets together without switching the default or touching user-owned profiles. */
export function exportPresetProfiles(existing: string, presets: readonly PresetProfileInput[]): PresetProfilesOutput {
  const names = new Set<string>();
  const ids = new Set<string>();
  const profiles: ExportedPresetProfile[] = [];
  const warnings: string[] = [];
  let text = existing;
  for (const preset of presets) {
    const baseName = presetProfileName(preset.name);
    const baseDescription = `AgentScope: ${preset.name}`;
    const baseProfile = generateProfile(preset.registry, { ...preset.options, profileName: baseName, description: baseDescription });
    const runtimeRoot = preset.options.runtimeRoot ?? runtimeWorkspaceRoot(path.resolve(preset.options.root));
    const revision = JSON.stringify(canonical({
      profile: TOML.parse(baseProfile.text), runtimeRoot,
      filesystemMode: resolveFilesystemMode(runtimeRoot, preset.options.filesystemMode),
    }));
    const profileName = presetProfileName(preset.name, revision);
    if (names.has(preset.name) || ids.has(profileName)) { throw new Error(`Duplicate preset permission profile: ${preset.name}`); }
    names.add(preset.name);
    ids.add(profileName);
    const description = `${baseDescription} (${profileName.slice(-12, -6)})`;
    const generated = generateProfile(preset.registry, { ...preset.options, profileName, description });
    text = updateCodexConfig(text, generated.text, profileName, false);
    profiles.push({ presetName: preset.name, profileName, description, broadReadAccess: generated.broadReadAccess, runtimeRoot });
    warnings.push(...generated.warnings.map(warning => `${preset.name}: ${warning}`));
  }
  return { text, profiles, warnings, broadReadAccess: profiles.some(profile => profile.broadReadAccess) };
}
