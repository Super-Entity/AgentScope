import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as TOML from '@iarna/toml';
import type { ProfileOptions, Registry } from '../types';
import { generateProfile, hasManagedCodexProfileComment, removeManagedCodexProfiles, updateCodexConfig } from './profile';
import { runtimeWorkspaceRoot } from './runtimePaths';

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

/** Codex shows this ID directly in its picker, so retain the user's preset label. */
export function presetProfileName(name: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 80 || name !== name.trim() || name.startsWith(':') || /[\x00-\x1f\x7f\u2028\u2029]/.test(name)) {
    throw new Error('A preset profile requires a name of 1–80 characters without surrounding whitespace or control characters.');
  }
  return `${name} - AgentScope`;
}

function legacyProfilePrefix(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'preset';
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);
  return `agentscope-preset-${slug}-${hash}`;
}

/** Publish all presets together without switching the default or touching user-owned profiles. */
export function exportPresetProfiles(existing: string, presets: readonly PresetProfileInput[]): PresetProfilesOutput {
  const names = new Set<string>();
  const ids = new Set<string>();
  const profiles: ExportedPresetProfile[] = [];
  const warnings: string[] = [];
  const existingPermissions = (TOML.parse(existing).permissions ?? {}) as Record<string, { description?: string }>;
  const replacements = new Map<string, string>();
  for (const preset of presets) {
    const profileName = presetProfileName(preset.name);
    const legacyPrefix = legacyProfilePrefix(preset.name);
    for (const [name, profile] of Object.entries(existingPermissions)) {
      const suffix = name.slice(legacyPrefix.length);
      if (name.startsWith(legacyPrefix) && (suffix === '' || /^-[a-f0-9]{12}$/.test(suffix)) &&
          (profile.description === `AgentScope: ${preset.name}` ||
           (typeof profile.description === 'string' && profile.description.startsWith(`AgentScope: ${preset.name} (`) &&
            /^[a-f0-9]{6}\)$/.test(profile.description.slice(`AgentScope: ${preset.name} (`.length))))) {
        replacements.set(name, profileName);
      }
    }
  }
  let text = removeManagedCodexProfiles(existing, replacements);
  if (text !== existing) warnings.push('Legacy preset profile names were shortened. Existing chats using a previous generated name must select the preset again.');
  for (const preset of presets) {
    const profileName = presetProfileName(preset.name);
    const runtimeRoot = preset.options.runtimeRoot ?? runtimeWorkspaceRoot(path.resolve(preset.options.root));
    if (names.has(preset.name) || ids.has(profileName)) { throw new Error(`Duplicate preset permission profile: ${preset.name}`); }
    names.add(preset.name);
    ids.add(profileName);
    const description = profileName;
    const generated = generateProfile(preset.registry, { ...preset.options, profileName });
    const presetComment = `# AgentScope preset: ${JSON.stringify(preset.name)}`;
    const generatedText = `${presetComment}\n${generated.text}`;
    const previous = existingPermissions[profileName];
    if (previous && !hasManagedCodexProfileComment(existing, profileName, presetComment)) {
      throw new Error(`The ${profileName} profile conflicts with another permission profile. Choose a different preset name; AgentScope will not overwrite it.`);
    }
    text = updateCodexConfig(text, generatedText, profileName, false);
    if (previous && !isDeepStrictEqual(previous, (TOML.parse(generated.text).permissions as unknown as Record<string, unknown>)[profileName])) {
      warnings.push(`${preset.name}: Updating this named profile changes its saved permissions. Recheck permissions before continuing an existing chat that uses it.`);
    }
    profiles.push({ presetName: preset.name, profileName, description, broadReadAccess: generated.broadReadAccess, runtimeRoot });
    warnings.push(...generated.warnings.map(warning => `${preset.name}: ${warning}`));
  }
  return { text, profiles, warnings, broadReadAccess: profiles.some(profile => profile.broadReadAccess) };
}
