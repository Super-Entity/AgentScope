import * as path from 'node:path';

export type CodexRuntime = 'auto' | 'native' | 'wsl';

interface AbsolutePath { value: string; api: typeof path.posix }

/** Parse the path's own platform syntax, independently of the extension host. */
function absolutePath(value: string, label: string, rejectRoot = false): AbsolutePath {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a literal absolute path without surrounding whitespace or control characters.`);
  }
  if (/[*?\[\]{}]/.test(value)) {
    throw new Error(`${label} must use a literal path without wildcard patterns.`);
  }
  const windows = /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(value);
  const api = windows ? path.win32 : path.posix;
  if (!windows && (!value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value))) {
    throw new Error(`${label} must be fully absolute, such as /mnt/d/MyApps, D:\\MyApps, or a UNC directory.`);
  }
  const segments = value.split(windows ? /[\\/]/ : /\//);
  if (segments.includes('..')) {
    throw new Error(`${label} cannot traverse a parent directory with '..'.`);
  }
  if (windows && (segments.some((segment, index) => segment.includes(':') && !(index === 0 && /^[A-Za-z]:$/.test(segment))) ||
    /^(?:[/\\]{2})(?:\.|\?)[/\\]/.test(value))) {
    throw new Error(`${label} must be an ordinary fully absolute Windows drive or UNC path.`);
  }
  const normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  const withoutTrailingSeparators = normalized.replace(windows ? /[\\/]+$/ : /\/+$/, '');
  const rootWithoutTrailingSeparators = root.replace(windows ? /[\\/]+$/ : /\/+$/, '');
  if (rejectRoot && withoutTrailingSeparators === rootWithoutTrailingSeparators) {
    throw new Error(`${label} must identify the selected workspace directory, not a filesystem or share root.`);
  }
  return { value: withoutTrailingSeparators === rootWithoutTrailingSeparators ? root : withoutTrailingSeparators, api };
}

/** Select only the concrete runtime location of this workspace, never all session roots. */
export function runtimeWorkspaceRoot(localRoot: string, runtime: CodexRuntime = 'auto', explicitRoot = '', runInWsl = false): string {
  if (!['auto', 'native', 'wsl'].includes(runtime)) {
    throw new Error('Codex runtime must be auto, native, or wsl.');
  }
  if (typeof runInWsl !== 'boolean') { throw new Error('The Codex WSL setting must be true or false.'); }
  const local = absolutePath(localRoot, 'The local workspace root');
  const useWsl = runtime === 'wsl' || (runtime === 'auto' && runInWsl);
  if (explicitRoot !== '') {
    const explicit = absolutePath(explicitRoot, 'The Codex workspace root override', true);
    if (useWsl && explicit.api === path.win32) {
      throw new Error('A Codex workspace root override for WSL must use its Linux absolute path, such as /mnt/d/MyApps.');
    }
    return explicit.value;
  }
  if (!useWsl || local.api === path.posix) { return local.value; }
  const drive = /^([A-Za-z]):\\(.*)$/.exec(local.value);
  if (drive) {
    return path.posix.join('/mnt', drive[1].toLowerCase(), ...drive[2].split('\\'));
  }
  const wslShare = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(?:\\(.*))?$/i.exec(local.value);
  if (wslShare) { return path.posix.join('/', ...(wslShare[1] ?? '').split('\\')); }
  throw new Error('This UNC workspace has no automatic WSL mapping. Set agentscope.codexWorkspaceRoot to the selected folder\'s Linux absolute path.');
}

/** Translate a verified local descendant while retaining its selected-root boundary. */
export function profileTarget(localRoot: string, localTarget: string, runtimeRoot: string): string {
  const local = absolutePath(localRoot, 'The local workspace root');
  const target = absolutePath(localTarget, 'The local permission target');
  const runtime = absolutePath(runtimeRoot, 'The Codex workspace root');
  if (local.api !== target.api) {
    throw new Error('A permission target must use the selected workspace\'s local path syntax.');
  }
  const relative = local.api.relative(local.value, target.value);
  if (local.api.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${local.api.sep}`)) {
    throw new Error(`A permission target must remain inside the selected workspace: ${localTarget}`);
  }
  if (!relative) { return runtime.value; }
  const segments = relative.split(local.api.sep);
  if (local.api === path.posix && runtime.api === path.win32 && segments.some(segment => /[\\:]/.test(segment))) {
    throw new Error('A POSIX permission target containing a literal backslash or colon cannot map to the same path on Windows.');
  }
  return runtime.api.join(runtime.value, ...segments);
}
