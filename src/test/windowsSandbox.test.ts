import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectWindowsSandbox, SandboxProcessRequest, SandboxProcessResult, WindowsSandboxOptions } from '../windowsSandbox';

const nativeOptions: WindowsSandboxOptions = {
  workspaceRoot: 'D:\\My Apps',
  runtimeRoot: 'D:\\My Apps',
  platform: 'win32',
  release: '10.0.26100.9278',
};

const success: SandboxProcessResult = { exitCode: 0, stdout: 'AGENTSCOPE_MXC_OK\r\n', stderr: '' };

test('MXC probes only a native Windows runtime on an eligible host', async () => {
  const cases: Array<[Partial<WindowsSandboxOptions>, string]> = [
    [{ platform: 'linux' }, 'not-windows'],
    [{ platform: 'darwin' }, 'not-windows'],
    [{ runtimeRoot: '/mnt/d/My Apps' }, 'non-native-runtime'],
    [{ runtimeRoot: '/home/user/project' }, 'non-native-runtime'],
    [{ release: '10.0.19045.7807' }, 'windows-too-old'],
    [{ release: '10.0.22631.9999' }, 'windows-too-old'],
    [{ release: '6.3.9600' }, 'windows-too-old'],
    [{ release: 'unknown' }, 'windows-version-unknown'],
  ];
  for (const [overrides, code] of cases) {
    const result = await detectWindowsSandbox({
      ...nativeOptions,
      ...overrides,
      run: async () => { assert.fail(`Unexpected probe for ${code}`); },
    });
    assert.deepEqual({ code: result.code, eligible: result.eligible, probed: result.probed, available: result.mxcAvailable },
      { code, eligible: false, probed: false, available: false });
  }
});

test('Recent Windows builds establish eligibility, never MXC availability without a successful probe', async () => {
  for (const release of ['10.0.26100', '10.0.26100.1', '10.0.26200.9278', '10.0.27000']) {
    let calls = 0;
    const result = await detectWindowsSandbox({
      ...nativeOptions, release,
      run: async () => { calls++; return { exitCode: 1, stdout: '', stderr: 'MXC is unavailable or blocked by policy' }; },
    });
    assert.equal(calls, 1);
    assert.equal(result.eligible, true);
    assert.equal(result.probed, true);
    assert.equal(result.mxcAvailable, false);
    assert.equal(result.code, 'probe-failed');
  }
});

test('The verification command forces MXC, includes managed requirements and has bounded output and duration', async () => {
  let request: SandboxProcessRequest | undefined;
  const result = await detectWindowsSandbox({
    ...nativeOptions,
    codexExecutable: 'C:\\Program Files\\Codex\\codex.exe',
    timeoutMs: 8_000,
    run: async received => { request = received; return success; },
  });
  assert.equal(result.mxcAvailable, true);
  assert.equal(result.code, 'mxc-verified');
  assert.deepEqual(request, {
    executable: 'C:\\Program Files\\Codex\\codex.exe',
    args: ['-c', 'windows.sandbox=mxc', 'sandbox', '--include-managed-config', '--permission-profile', ':workspace', '--', 'cmd.exe', '/d', '/c', 'echo', 'AGENTSCOPE_MXC_OK'],
    cwd: 'D:\\My Apps',
    timeoutMs: 8_000,
    maxBuffer: 65_536,
  });
});

test('MXC availability requires exit zero and the exact marker on stdout', async () => {
  const failures: SandboxProcessResult[] = [
    { ...success, exitCode: 1 },
    { ...success, exitCode: null },
    { ...success, stdout: '' },
    { ...success, stdout: '', stderr: 'AGENTSCOPE_MXC_OK' },
    { ...success, stdout: 'echo AGENTSCOPE_MXC_OK\n' },
    { ...success, stdout: 'AGENTSCOPE_MXC_OK_MORE\n' },
    { ...success, errorCode: 'ENOENT' },
  ];
  for (const failure of failures) {
    const result = await detectWindowsSandbox({ ...nativeOptions, run: async () => failure });
    assert.equal(result.mxcAvailable, false);
    assert.equal(result.code, 'probe-failed');
  }
});

test('Timeouts and runner failures leave MXC unavailable without exposing command output', async () => {
  const timedOut = await detectWindowsSandbox({
    ...nativeOptions,
    run: async () => ({ ...success, timedOut: true, stderr: 'private output' }),
  });
  assert.equal(timedOut.code, 'probe-timeout');
  assert.equal(timedOut.mxcAvailable, false);
  assert.equal(timedOut.probed, true);
  const failed = await detectWindowsSandbox({ ...nativeOptions, run: async () => { throw new Error('private output'); } });
  assert.equal(failed.code, 'probe-failed');
  assert.equal(failed.mxcAvailable, false);
  assert.doesNotMatch(failed.reason, /private output/);
});

test('UNC workspaces can use native MXC and inherit the default executable and finite timeout', async () => {
  let request: SandboxProcessRequest | undefined;
  const result = await detectWindowsSandbox({
    ...nativeOptions,
    workspaceRoot: '\\\\server\\share\\project',
    runtimeRoot: '\\\\server\\share\\project',
    run: async received => { request = received; return success; },
  });
  assert.equal(result.mxcAvailable, true);
  assert.equal(request?.executable, 'codex.exe');
  assert.equal(request?.timeoutMs, 15_000);
});

test('Invalid probe bounds and executable names are rejected before spawning', async () => {
  const run = async () => { assert.fail('No invalid probe may spawn'); };
  for (const timeoutMs of [0, -1, 60_001, Number.POSITIVE_INFINITY, Number.NaN, 1.5]) {
    await assert.rejects(detectWindowsSandbox({ ...nativeOptions, timeoutMs, run }), /timeout/);
  }
  for (const codexExecutable of ['', '   ', 'codex\u0000.exe', 'codex\n.exe']) {
    await assert.rejects(detectWindowsSandbox({ ...nativeOptions, codexExecutable, run }), /executable/);
  }
});
