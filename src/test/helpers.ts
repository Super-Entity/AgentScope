import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestContext } from 'node:test';
import { ModuleConfig, Registry } from '../types';
import { emptyRegistry, writeAgentsRegistry } from '../core/registry';

export function project(overrides: Partial<ModuleConfig> = {}): ModuleConfig {
  return {
    path: 'project', enabled: true, restrict_paths: true,
    read_paths: ['references'], write_paths: ['drafts'], instruction_file: null,
    ...overrides,
  };
}

export function registry(overrides: Record<string, ModuleConfig> = {}): Registry {
  return {
    shared_resources: { read_paths: ['Instructions'], write_paths: [] },
    submodules: { project: project(), ...overrides },
  };
}

export function policy(value: unknown, prose = '# Local policy\n\nKeep my editorial rules.\n'): string {
  // Keep these fixtures owned by the legacy writer, including deliberately
  // malformed payloads that parsing tests must be allowed to construct.
  const generated = writeAgentsRegistry('', emptyRegistry());
  const legacy = generated.replace(/(```json\r?\n)[\s\S]*?(\r?\n```)/, (_match, start: string, end: string) =>
    `${start}${JSON.stringify(value, null, 2)}${end}`);
  return `${prose}\n${legacy}\nTail policy remains.\n`;
}

export async function fixture(t: TestContext): Promise<{ base: string; root: string; outside: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-test-')));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(async () => {
    const resolved = path.resolve(base);
    const tmp = await fs.realpath(os.tmpdir());
    const relative = path.relative(tmp, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to remove a test directory outside the temporary root: ${base}`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { base, root, outside };
}

export async function directoryLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
