import { isDeepStrictEqual } from 'node:util';
import * as TOML from '@iarna/toml';

type Backend = 'mxc' | 'elevated';
type Table = Record<string, unknown>;
interface Statement { start: number; end: number; text: string }

function parse(text: string, label: string): Table {
  try { return TOML.parse(text) as Table; }
  catch { throw new Error(`${label} contains invalid TOML. Review the Windows sandbox setting before applying.`); }
}

function table(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** Split TOML statements, keeping multiline string contents out of key/table matching. */
function statements(text: string): Statement[] {
  const result: Statement[] = [];
  let start = 0;
  let string: 'basic' | 'literal' | 'multiBasic' | 'multiLiteral' | null = null;
  let escaped = false;
  let comment = false;
  let brackets = 0;
  let braces = 0;
  const finish = (end: number): void => {
    result.push({ start, end, text: text.slice(start, end) });
    start = end;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (comment) {
      if (character === '\n') {
        comment = false;
        if (brackets === 0 && braces === 0) { finish(index + 1); }
      }
      continue;
    }
    if (string === 'basic' || string === 'multiBasic') {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (string === 'multiBasic' && text.slice(index, index + 3) === '"""') {
        while (text[index + 3] === '"') { index++; }
        index += 2;
        string = null;
      } else if (string === 'basic' && character === '"') { string = null; }
      continue;
    }
    if (string === 'literal' || string === 'multiLiteral') {
      if (string === 'multiLiteral' && text.slice(index, index + 3) === "'''") {
        while (text[index + 3] === "'") { index++; }
        index += 2;
        string = null;
      } else if (string === 'literal' && character === "'") { string = null; }
      continue;
    }
    if (character === '#') { comment = true; continue; }
    if (character === '"' || character === "'") {
      const triple = text.slice(index, index + 3) === character.repeat(3);
      string = character === '"' ? triple ? 'multiBasic' : 'basic' : triple ? 'multiLiteral' : 'literal';
      if (triple) { index += 2; }
      continue;
    }
    if (character === '[') { brackets++; }
    else if (character === ']') { brackets--; }
    else if (character === '{') { braces++; }
    else if (character === '}') { braces--; }
    else if (character === '\n' && brackets === 0 && braces === 0) { finish(index + 1); }
  }
  if (start < text.length) { finish(text.length); }
  return result;
}

const simpleWindowsHeader = /^[ \t]*\[[ \t]*windows[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/;
const simpleString = '(?:"(?:[^"\\\\\\r\\n]|\\\\.)*"|\'[^\'\\r\\n]*\')';
const valueSuffix = '([ \\t]*(?:#[^\\r\\n]*)?)(\\r?\\n)?$';
const tableAssignment = new RegExp(`^([ \\t]*(?:sandbox|"sandbox"|'sandbox')[ \\t]*=[ \\t]*)${simpleString}${valueSuffix}`);
const dottedAssignment = new RegExp(`^([ \\t]*windows[ \\t]*\\.[ \\t]*sandbox[ \\t]*=[ \\t]*)${simpleString}${valueSuffix}`);

/**
 * Change only windows.sandbox. Unsupported layouts fail closed rather than
 * reserializing the document, losing comments, or changing another TOML table.
 */
export function updateWindowsSandbox(existing: string, backend: Backend): string {
  if (backend !== 'mxc' && backend !== 'elevated') {
    throw new Error('The Windows sandbox backend must be mxc or elevated.');
  }
  const previous = parse(existing, 'Codex config');
  if (Object.hasOwn(previous, 'windows') && !table(previous.windows)) {
    throw new Error('windows must be a TOML table before selecting a Windows sandbox backend.');
  }
  const previousWindows = previous.windows as Table | undefined;
  if (previousWindows?.sandbox === backend) { return existing; }

  const expected = Object.assign(Object.create(Object.getPrototypeOf(previous)), previous) as Table;
  expected.windows = Object.assign(Object.create(Object.getPrototypeOf(previousWindows ?? previous)), previousWindows, { sandbox: backend });
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  let root = true;
  let inWindows = false;
  let windowsHeader: Statement | undefined;
  let rootWindowsDeclaration = false;
  let target: Statement | undefined;
  let targetMatch: RegExpExecArray | undefined;
  for (const statement of statements(existing)) {
    const trimmed = statement.text.trimStart();
    if (trimmed.startsWith('[')) {
      root = false;
      inWindows = simpleWindowsHeader.test(statement.text);
      if (inWindows) { windowsHeader = statement; }
      continue;
    }
    if (root && /^[ \t]*(?:windows|"windows"|'windows')[ \t]*(?:\.|=)/.test(statement.text)) {
      rootWindowsDeclaration = true;
    }
    const match = (root ? dottedAssignment : inWindows ? tableAssignment : undefined)?.exec(statement.text);
    if (match) {
      if (target) { throw new Error('Cannot safely locate a unique Windows sandbox assignment.'); }
      target = statement;
      targetMatch = match;
    }
  }

  let updated: string;
  if (target && targetMatch) {
    updated = existing.slice(0, target.start) + targetMatch[1] + `"${backend}"` + targetMatch[2] + (targetMatch[3] ?? '') + existing.slice(target.end);
  } else if (previousWindows && Object.hasOwn(previousWindows, 'sandbox')) {
    throw new Error('Cannot safely update this Windows sandbox layout. Use a simple sandbox string in [windows] or a root windows.sandbox key.');
  } else if (windowsHeader) {
    const separator = windowsHeader.text.endsWith('\n') ? '' : eol;
    updated = existing.slice(0, windowsHeader.end) + separator + `sandbox = "${backend}"${eol}` + existing.slice(windowsHeader.end);
  } else {
    if (rootWindowsDeclaration) {
      throw new Error('Cannot safely extend an inline or dotted Windows table. Use a plain [windows] table.');
    }
    const separator = !existing || existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol;
    updated = existing + separator + `[windows]${eol}sandbox = "${backend}"${eol}`;
  }
  let actual: Table;
  try { actual = TOML.parse(updated) as Table; }
  catch { throw new Error('Cannot safely add the Windows sandbox setting to this TOML layout. Use a plain [windows] table.'); }
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error('Updating windows.sandbox would change unrelated TOML configuration. Use a simple [windows] table before applying.');
  }
  return updated;
}
