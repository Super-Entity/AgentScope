import { execFile } from 'node:child_process';
import * as os from 'node:os';

export interface SandboxProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface SandboxProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorCode?: string;
}

/** A runner must terminate its process when timeoutMs or maxBuffer is exceeded. */
export type SandboxProcessRunner = (request: SandboxProcessRequest) => Promise<SandboxProcessResult>;

export interface WindowsSandboxOptions {
  /** The local selected workspace, used as the probe's working directory. */
  workspaceRoot: string;
  /** The resolved Codex workspace path; a POSIX path means WSL or another POSIX runtime. */
  runtimeRoot: string;
  codexExecutable?: string;
  platform?: NodeJS.Platform;
  release?: string;
  timeoutMs?: number;
  run?: SandboxProcessRunner;
}

export type WindowsSandboxDetectionCode =
  | 'not-windows'
  | 'non-native-runtime'
  | 'windows-too-old'
  | 'windows-version-unknown'
  | 'probe-failed'
  | 'probe-timeout'
  | 'mxc-verified';

export interface WindowsSandboxDetection {
  mxcAvailable: boolean;
  /** Eligibility permits a capability probe; it does not establish MXC support. */
  eligible: boolean;
  probed: boolean;
  code: WindowsSandboxDetectionCode;
  reason: string;
}

const probeMarker = 'AGENTSCOPE_MXC_OK';
const maxProbeOutput = 64 * 1024;

const runSandboxProcess: SandboxProcessRunner = request => new Promise(resolve => {
  execFile(request.executable, request.args, {
    cwd: request.cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: request.timeoutMs,
    maxBuffer: request.maxBuffer,
  }, (error, stdout, stderr) => {
    resolve({
      exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      stdout,
      stderr,
      timedOut: Boolean(error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
      errorCode: typeof error?.code === 'string' ? error.code : undefined,
    });
  });
});

function unavailable(code: WindowsSandboxDetectionCode, reason: string, eligible = false, probed = false): WindowsSandboxDetection {
  return { mxcAvailable: false, eligible, probed, code, reason };
}

/**
 * Verify the native MXC backend without changing saved Codex settings or contacting a model.
 * Windows build numbers only gate the probe. Even a sufficiently recent Windows 11
 * installation may lack the native capability or have an organization policy blocking it.
 */
export async function detectWindowsSandbox(options: WindowsSandboxOptions): Promise<WindowsSandboxDetection> {
  if ((options.platform ?? os.platform()) !== 'win32') {
    return unavailable('not-windows', 'The extension host is not native Windows; use the runtime\'s sandbox.');
  }
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(options.runtimeRoot)) {
    return unavailable('non-native-runtime', 'Codex runs in WSL or another POSIX runtime; Windows MXC does not apply.');
  }

  // os.release() commonly omits the servicing revision (UBR). Build 26100 is
  // therefore a coarse eligibility check; the forced-MXC probe remains decisive.
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(options.release ?? os.release());
  if (!version) {
    return unavailable('windows-version-unknown', 'The Windows version could not be verified; MXC has not been selected.');
  }
  const major = Number(version[1]);
  const build = Number(version[3]);
  if (major < 10 || (major === 10 && build < 26100)) {
    return unavailable('windows-too-old', 'MXC requires a supported Windows 11 24H2 or newer installation; use the legacy Windows sandbox or WSL.');
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('The MXC probe timeout must be an integer between 1 and 60000 milliseconds.');
  }
  const executable = options.codexExecutable ?? 'codex.exe';
  if (!executable.trim() || /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error('The Codex executable must be a literal executable name or path.');
  }
  const request: SandboxProcessRequest = {
    executable,
    args: [
      '-c', 'windows.sandbox=mxc', 'sandbox', '--include-managed-config',
      '--permission-profile', ':workspace', '--', 'cmd.exe', '/d', '/c', 'echo', probeMarker,
    ],
    cwd: options.workspaceRoot,
    timeoutMs,
    maxBuffer: maxProbeOutput,
  };

  let result: SandboxProcessResult;
  try {
    result = await (options.run ?? runSandboxProcess)(request);
  } catch {
    return unavailable('probe-failed', 'Codex could not run the MXC verification command; MXC has not been selected.', true, true);
  }
  if (result.timedOut) {
    return unavailable('probe-timeout', 'The MXC verification command timed out; MXC has not been selected.', true, true);
  }
  if (result.exitCode !== 0 || result.errorCode || !result.stdout.split(/\r?\n/).some(line => line.trim() === probeMarker)) {
    return unavailable('probe-failed', 'Codex did not verify MXC startup. Check the Codex version, native Windows capabilities and managed sandbox requirements.', true, true);
  }
  return {
    mxcAvailable: true,
    eligible: true,
    probed: true,
    code: 'mxc-verified',
    reason: 'Codex successfully started a command with the forced MXC backend and managed requirements.',
  };
}
