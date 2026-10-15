import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, SyntaxKind } from 'jsonc-parser';
import { parseJsoncStrict, validateRegistry } from './core/registry';
import { Registry } from './types';

/** Editor state only. Codex enforces the exported config.toml profiles. */
export const SCOPE_CONFIGURATION_FILE = '.vscode/agentscope.json';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readScopeConfiguration(text: string, root?: string): Registry {
  const value = parseJsoncStrict(text, 'AgentScope configuration');
  if (!object(value) || !Object.hasOwn(value, 'version') || value.version !== 1 || !Object.hasOwn(value, 'registry') || !object(value.registry)) {
    throw new Error('AgentScope configuration requires version 1 and a registry object.');
  }
  const registry = value.registry as Registry;
  validateRegistry(registry, root);
  return registry;
}

/** Projects own map membership; other objects may include user annotations. */
function mergeAnnotations(previous: unknown, incoming: unknown, keys: string[] = []): unknown {
  if (!object(incoming)) return structuredClone(incoming);
  const result: Record<string, unknown> = {};
  const authoritative = keys.length === 1 && keys[0] === 'submodules';
  if (object(previous) && !authoritative) {
    for (const [key, value] of Object.entries(previous)) {
      Object.defineProperty(result, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    }
  }
  for (const [key, value] of Object.entries(incoming)) {
    Object.defineProperty(result, key, {
      value: mergeAnnotations(object(previous) && Object.hasOwn(previous, key) ? previous[key] : undefined, value, [...keys, key]),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function comments(text: string): string[] {
  const scanner = createScanner(text, false);
  const result: string[] = [];
  let token: SyntaxKind;
  while ((token = scanner.scan()) !== SyntaxKind.EOF) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      result.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return result;
}

/** JSONC removal edits can consume adjacent comments; retain every comment token. */
function preserveComments(before: string, after: string, keys: Array<string | number>, eol: string, indent: string): string {
  const remaining = new Map<string, number>();
  for (const comment of comments(after)) remaining.set(comment, (remaining.get(comment) ?? 0) + 1);
  const lost = comments(before).filter(comment => {
    const count = remaining.get(comment) ?? 0;
    if (count === 0) return true;
    remaining.set(comment, count - 1);
    return false;
  });
  if (!lost.length) return after;
  const tree = parseTree(after, [], { allowTrailingComma: true, disallowComments: false });
  const parent = keys.slice(0, -1);
  let container = tree && findNodeAtLocation(tree, parent);
  while (parent.length && (!container || !['array', 'object'].includes(container.type))) {
    parent.pop();
    container = tree && findNodeAtLocation(tree, parent);
  }
  if (!container || !['array', 'object'].includes(container.type)) {
    throw new Error('Cannot preserve comments in the edited AgentScope configuration container.');
  }
  const lineStart = after.lastIndexOf('\n', container.offset - 1) + 1;
  const baseIndent = /^[ \t]*/.exec(after.slice(lineStart, container.offset))?.[0] ?? '';
  const insertion = `${eol}${lost.map(comment => `${baseIndent}${indent}${comment}`).join(eol)}${eol}${baseIndent}`;
  const offset = container.offset + container.length - 1;
  return after.slice(0, offset) + insertion + after.slice(offset);
}

export function writeScopeConfiguration(before: string | null, registry: Registry): string {
  validateRegistry(registry);
  if (before === null) return `${JSON.stringify({ version: 1, registry }, null, 2)}\n`;
  const previous = readScopeConfiguration(before);
  const next = mergeAnnotations(previous, registry) as Registry;
  validateRegistry(next);
  const indent = /\n([ \t]+)"/.exec(before)?.[1] ?? '  ';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const options = { formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 2 : indent.length, eol } };
  let text = before;
  const edit = (keys: Array<string | number>, value: unknown): void => {
    const edits = modify(text, keys, value, options);
    const edited = applyEdits(text, edits);
    text = edits.some(change => comments(text.slice(change.offset, change.offset + change.length)).length > 0)
      ? preserveComments(text, edited, keys, eol, indent) : edited;
  };
  const sync = (keys: Array<string | number>, oldValue: unknown, newValue: unknown): void => {
    if (isDeepStrictEqual(oldValue, newValue)) return;
    if (object(oldValue) && object(newValue)) {
      for (const key of Object.keys(oldValue)) {
        if (!Object.hasOwn(newValue, key)) edit([...keys, key], undefined);
      }
      for (const key of Object.keys(newValue)) {
        sync([...keys, key], Object.hasOwn(oldValue, key) ? oldValue[key] : undefined, newValue[key]);
      }
    } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      for (let index = 0; index < Math.min(oldValue.length, newValue.length); index++) sync([...keys, index], oldValue[index], newValue[index]);
      for (let index = oldValue.length - 1; index >= newValue.length; index--) edit([...keys, index], undefined);
      for (let index = oldValue.length; index < newValue.length; index++) edit([...keys, index], newValue[index]);
    } else edit(keys, newValue);
  };
  sync(['registry'], previous, next);
  const actual = readScopeConfiguration(text);
  const expected = { ...(parseJsoncStrict(before, 'AgentScope configuration') as Record<string, unknown>), registry: next };
  if (!isDeepStrictEqual(actual, next) || !isDeepStrictEqual(parseJsoncStrict(text, 'Updated AgentScope configuration'), expected)) {
    throw new Error('Updating the scope registry would change unrelated AgentScope configuration.');
  }
  return text;
}
