import { applyEdits, modify } from 'jsonc-parser';
import { normalizeRelative } from './paths';
import { parseJsoncStrict } from './registry';

/** Only exact project paths are owned; broader user patterns remain unchanged. */
export function updateExcludesSettings(text: string, modulePaths: string[], hiddenByPath: Record<string, boolean>, includeSearch: boolean): string {
  let result = text.trim() ? text : '{}\n';
  const settings = parseJsoncStrict(result, 'VS Code settings');
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) { throw new Error('VS Code settings must be a JSON/JSONC object.'); }
  const keys = includeSearch ? ['files.exclude', 'search.exclude'] : ['files.exclude'];
  for (const key of keys) {
    const current = (settings as Record<string, unknown>)[key];
    if (current !== undefined && (current === null || typeof current !== 'object' || Array.isArray(current))) { throw new Error(`${key} must be an object of exclusion patterns.`); }
  }
  const eol = result.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)"/.exec(result)?.[1];
  const format = { insertSpaces: !indent?.includes('\t'), tabSize: indent && !indent.includes('\t') ? indent.length : 2, eol };
  for (const modulePath of modulePaths) {
    const normalized = normalizeRelative(modulePath);
    const hidden = hiddenByPath[modulePath] ?? hiddenByPath[normalized];
    if (typeof hidden !== 'boolean') { throw new Error(`Missing visibility choice for project: ${modulePath}`); }
    if (normalized === '.') {
      if (hidden) { throw new Error('Cannot hide the entire workspace root.'); }
      continue;
    }
    for (const key of keys) {
      result = applyEdits(result, modify(result, [key, normalized], hidden, { formattingOptions: format }));
    }
  }
  return result;
}
