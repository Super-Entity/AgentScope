import type { CodexFilesystemMode } from './core/runtimePaths';

export interface ModuleConfig {
  path: string;
  enabled: boolean;
  restrict_paths: boolean;
  read_paths: string[];
  write_paths: string[];
  instruction_file: string | null;
  [key: string]: unknown;
}

export interface Registry {
  shared_resources: { read_paths: string[]; write_paths: string[]; [key: string]: unknown };
  submodules: Record<string, ModuleConfig>;
  [key: string]: unknown;
}

export interface DiscoveredModule { name: string; path: string }

export interface ProfileOptions {
  root: string;
  /** The same selected workspace as seen by the Codex runtime (for example WSL). */
  runtimeRoot?: string;
  filesystemMode?: CodexFilesystemMode;
  profileName: string;
  allowNetwork: boolean;
  /** Exact Git paths already resolved and verified to belong to enabled modules. */
  gitReadPaths?: string[];
  gitWritePaths?: string[];
}

export interface ProfileOutput { text: string; warnings: string[]; broadReadAccess: boolean }
export interface FileChange { path: string; before: string | null; after: string }
/** Stable directory identity; timestamps changed by child writes are intentionally excluded. */
export interface DirectoryIdentity { dev: string; ino: string; birthtimeNs: string }
export interface ApplyPlan {
  changes: FileChange[];
  warnings: string[];
  /** Windows compatibility allows OS-level reads outside the selected paths. */
  broadReadAccess?: boolean;
  /** Read-only inputs whose contents must still match at apply time. */
  checks?: Array<{ path: string; expected: string | null }>;
  /** Scope targets rechecked before writing configuration. */
  pathChecks?: Array<{ root: string; path: string; resolved: string }>;
  /** Loaded directory identities rechecked before staging and before publishing any writes. */
  directoryChecks?: Array<{ path: string; identity: DirectoryIdentity }>;
}

export interface WorkspaceState {
  root: string;
  /** Identity captured on load, so an ordinary replacement at the same pathname is refused. */
  rootIdentity?: DirectoryIdentity;
  registry: Registry;
  /** Module names mapped to whether their folder is hidden. */
  hidden: Record<string, boolean>;
  /** Exact workspace-resource paths mapped to Explorer visibility, independently of access. */
  resourceHidden?: Record<string, boolean>;
  /** Only resource visibility choices explicitly changed in the current draft. */
  resourceVisibilityChanges?: Record<string, boolean>;
  dirty: boolean;
  warnings: string[];
  /** Explicit draft permission to rebuild policy files after configuration damage. */
  reconfigurePolicy?: boolean;
  /** Expected contents captured when the workspace was loaded, for conflict detection. */
  files?: Record<string, string | null>;
}
