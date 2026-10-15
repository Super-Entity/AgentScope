import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexFilesystemMode, CodexRuntime, profileTarget, resolveFilesystemMode, runtimeWorkspaceRoot } from '../core/runtimePaths';

test('Filesystem modes follow the effective runtime path rather than the extension host', () => {
  for (const root of ['D:\\MyApps', 'd:/My Apps', '\\\\server\\share\\MyApps']) {
    assert.equal(resolveFilesystemMode(root), 'windows-compatible');
    assert.equal(resolveFilesystemMode(root, 'windows-compatible'), 'windows-compatible');
    assert.equal(resolveFilesystemMode(root, 'strict'), 'strict');
  }
  for (const root of ['/mnt/d/MyApps', '/home/user/MyApps', '/Users/dev/MyApps']) {
    assert.equal(resolveFilesystemMode(root), 'strict');
    assert.equal(resolveFilesystemMode(root, 'windows-compatible'), 'strict', 'Portable compatibility presets must keep POSIX reads restricted');
    assert.equal(resolveFilesystemMode(root, 'strict'), 'strict');
  }
});

test('Hybrid runtime mappings choose the filesystem mode after mapping the workspace', () => {
  const native = runtimeWorkspaceRoot('D:\\MyApps', 'auto', '', false);
  const wsl = runtimeWorkspaceRoot('D:\\MyApps', 'auto', '', true);
  assert.equal(resolveFilesystemMode(native), 'windows-compatible');
  assert.equal(resolveFilesystemMode(wsl), 'strict');
  assert.equal(resolveFilesystemMode(runtimeWorkspaceRoot('/work/MyApps', 'native', 'E:\\MyApps')), 'windows-compatible');
  assert.equal(resolveFilesystemMode(runtimeWorkspaceRoot('D:\\MyApps', 'wsl', '/custom/MyApps')), 'strict');
});

test('Filesystem mode resolution rejects malformed modes and runtime paths', () => {
  for (const mode of ['unknown', '', null, true, {}]) {
    assert.throws(() => resolveFilesystemMode('D:\\MyApps', mode as CodexFilesystemMode), /filesystem mode/);
  }
  for (const root of ['relative', '/work/../MyApps', 'D:relative', ':workspace_roots']) {
    assert.throws(() => resolveFilesystemMode(root));
  }
});

test('Native paths follow their own platform syntax regardless of the extension host', () => {
  assert.equal(runtimeWorkspaceRoot('D:\\MyApps\\'), 'D:\\MyApps');
  assert.equal(runtimeWorkspaceRoot('D:/MyApps/./AgentScope', 'native', '', true), 'D:\\MyApps\\AgentScope');
  assert.equal(runtimeWorkspaceRoot('/mnt/d/MyApps/./', 'native'), '/mnt/d/MyApps');
  assert.equal(runtimeWorkspaceRoot('\\\\server\\share\\MyApps'), '\\\\server\\share\\MyApps');
});

test('macOS and other POSIX roots preserve spaces, case and Unicode spelling', () => {
  const root = '/Users/کاربر/Projects/My App';
  for (const runtime of ['auto', 'native', 'wsl'] as const) {
    assert.equal(runtimeWorkspaceRoot(root, runtime, '', true), root);
  }
  assert.equal(profileTarget(root, `${root}/Café notes/داده.md`, root), `${root}/Café notes/داده.md`);
  assert.equal(profileTarget(root, `${root}/Cafe\u0301 notes/داده.md`, root), `${root}/Cafe\u0301 notes/داده.md`);
  const externalRoot = '/Volumes/External Drive/My App';
  assert.equal(runtimeWorkspaceRoot(externalRoot), externalRoot);
  assert.equal(profileTarget(externalRoot, `${externalRoot}/src/Hello world.ts`, externalRoot), `${externalRoot}/src/Hello world.ts`);
  assert.throws(() => profileTarget(root, '/Users/کاربر/projects/My App/file.md', root), /inside the selected workspace/);
});

test('Auto converts Windows drive paths only when Codex is configured to run in WSL', () => {
  assert.equal(runtimeWorkspaceRoot('D:\\MyApps'), 'D:\\MyApps');
  assert.equal(runtimeWorkspaceRoot('D:\\MyApps', 'auto', '', true), '/mnt/d/MyApps');
  assert.equal(runtimeWorkspaceRoot('d:/My Apps', 'wsl'), '/mnt/d/My Apps');
  assert.equal(runtimeWorkspaceRoot('/home/user/MyApps', 'auto', '', true), '/home/user/MyApps');
  assert.equal(runtimeWorkspaceRoot('/home/user/MyApps', 'wsl'), '/home/user/MyApps');
});

test('WSL shares map to their Linux directory while other shares require an explicit mapping', () => {
  assert.equal(runtimeWorkspaceRoot('\\\\wsl$\\Ubuntu\\home\\user\\MyApps', 'wsl'), '/home/user/MyApps');
  assert.equal(runtimeWorkspaceRoot('\\\\WSL.LOCALHOST\\Ubuntu\\home\\user\\MyApps', 'auto', '', true), '/home/user/MyApps');
  assert.throws(() => runtimeWorkspaceRoot('\\\\server\\share\\MyApps', 'wsl'), /UNC.*agentscope\.codexWorkspaceRoot/);
  assert.equal(runtimeWorkspaceRoot('\\\\server\\share\\MyApps', 'wsl', '/work/MyApps'), '/work/MyApps');
});

test('Explicit runtime roots support remote locations and custom WSL mount points', () => {
  assert.equal(runtimeWorkspaceRoot('D:\\MyApps', 'wsl', '/drives/d/MyApps/./'), '/drives/d/MyApps');
  assert.equal(runtimeWorkspaceRoot('/work/MyApps', 'native', 'E:/code/MyApps'), 'E:\\code\\MyApps');
  assert.equal(runtimeWorkspaceRoot('/work/MyApps', 'native', '\\\\server\\share\\MyApps\\'), '\\\\server\\share\\MyApps');
  assert.throws(() => runtimeWorkspaceRoot('D:\\MyApps', 'wsl', 'E:\\MyApps'), /WSL.*Linux absolute path/);
});

test('Runtime roots reject relative paths, traversal, wildcards, control characters and root overrides', () => {
  for (const invalid of ['relative', 'D:relative', '\\rooted', '~/MyApps', '/work/../MyApps', 'D:\\work\\..\\MyApps', '/work/*', '/work/[a]', '/work/{a}', ' /work/MyApps', '/work/MyApps ', '/work/My\u0000Apps', '\\\\?\\D:\\MyApps']) {
    assert.throws(() => runtimeWorkspaceRoot('/work/MyApps', 'native', invalid), invalid);
  }
  for (const invalid of ['/', '/./', 'D:\\', 'D:/./', '\\\\server\\share', '\\\\server\\share\\']) {
    assert.throws(() => runtimeWorkspaceRoot('/work/MyApps', 'native', invalid), /workspace directory.*root/, invalid);
  }
  assert.throws(() => runtimeWorkspaceRoot('D:MyApps'), /fully absolute/);
  assert.throws(() => runtimeWorkspaceRoot('/work/MyApps', 'unsupported' as CodexRuntime), /runtime.*auto, native, or wsl/);
});

test('The reported access policy path maps to the concrete WSL workspace', () => {
  const root = 'D:\\MyApps';
  const runtimeRoot = runtimeWorkspaceRoot(root, 'auto', '', true);
  assert.equal(profileTarget(root, 'D:\\MyApps\\.agentscope\\access.md', runtimeRoot), '/mnt/d/MyApps/.agentscope/access.md');
  assert.equal(profileTarget(root, 'D:\\MyApps', runtimeRoot), '/mnt/d/MyApps');
  assert.equal(profileTarget(root, 'D:\\MyApps\\EnCoach\\src', runtimeRoot), '/mnt/d/MyApps/EnCoach/src');
});

test('Permission targets remain contained in the selected local root and do not repeat across roots', () => {
  assert.throws(() => profileTarget('D:\\MyApps', 'D:\\OtherApps\\EnCoach\\src', '/mnt/d/MyApps'), /inside the selected workspace/);
  assert.throws(() => profileTarget('D:\\MyApps', 'D:\\MyApps-other\\src', '/mnt/d/MyApps'), /inside the selected workspace/);
  assert.throws(() => profileTarget('D:\\MyApps', 'E:\\MyApps\\src', '/mnt/d/MyApps'), /inside the selected workspace/);
  assert.throws(() => profileTarget('/work/MyApps', '/work/OtherApps/src', '/runtime/MyApps'), /inside the selected workspace/);
  assert.throws(() => profileTarget('/work/MyApps', 'D:\\MyApps\\src', '/runtime/MyApps'), /local path syntax/);
  assert.equal(profileTarget('D:\\OtherApps', 'D:\\OtherApps\\EnCoach\\src', '/mnt/d/OtherApps'), '/mnt/d/OtherApps/EnCoach/src');
  assert.equal(profileTarget('/work/MyApps', '/work/MyApps/project/src', '/runtime/MyApps'), '/runtime/MyApps/project/src');
  assert.equal(profileTarget('/work/MyApps', '/work/MyApps/project/src', 'E:\\MyApps'), 'E:\\MyApps\\project\\src');
});

test('Native Windows containment recognizes drive case and exact UNC shares', () => {
  assert.equal(profileTarget('C:\\Users\\Dev\\My Apps', 'c:\\users\\dev\\my apps\\Café notes\\داده.md', 'C:\\Users\\Dev\\My Apps'),
    'C:\\Users\\Dev\\My Apps\\Café notes\\داده.md');
  const shareRoot = '\\\\server\\share\\My Apps';
  assert.equal(profileTarget(shareRoot, '\\\\SERVER\\SHARE\\My Apps\\src\\index.ts', shareRoot), '\\\\server\\share\\My Apps\\src\\index.ts');
  assert.throws(() => profileTarget(shareRoot, '\\\\server\\other-share\\My Apps\\src', shareRoot), /inside the selected workspace/);
  assert.throws(() => profileTarget(shareRoot, '\\\\other-server\\share\\My Apps\\src', shareRoot), /inside the selected workspace/);
});

test('A POSIX filename cannot become a Windows separator or alternate data stream', () => {
  for (const target of ['/work/MyApps/..\\outside', '/work/MyApps/folder\\file', '/work/MyApps/file:stream']) {
    assert.throws(() => profileTarget('/work/MyApps', target, 'E:\\MyApps'), /literal backslash or colon.*Windows/);
    assert.equal(profileTarget('/work/MyApps', target, '/runtime/MyApps'), target.replace('/work/MyApps', '/runtime/MyApps'));
  }
});
