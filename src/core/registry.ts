import { applyEdits, modify, parse, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { DiscoveredModule, ModuleConfig, Registry } from '../types';
import { normalizeRelative, resolveContained } from './paths';

const moduleFields = ['path', 'enabled', 'restrict_paths', 'read_paths', 'write_paths', 'instruction_file'] as const;
const resourceFields = ['read_paths', 'write_paths'] as const;
const safeObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownValue = (value: Record<string, unknown>, field: string): unknown => Object.hasOwn(value, field) ? value[field] : undefined;
const gitMetadata = (relative: string): boolean => relative.split('/').some(segment => (process.platform === 'win32' ? segment.toLowerCase() : segment) === '.git');

function rejectGitMetadata(relative: string): void {
  if (gitMetadata(relative)) { throw new Error(`Git metadata must be managed through verified Git paths, not access selections: ${relative}`); }
}

export function emptyRegistry(): Registry {
  return { shared_resources: { read_paths: [], write_paths: [] }, submodules: {} };
}

export function parseJsoncStrict(text: string, label: string): unknown {
  const errors: ParseError[] = [];
  const options = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false };
  const tree = parseTree(text, errors, options);
  if (errors.length) { throw new Error(`${label} contains invalid JSON/JSONC: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}.`); }
  if (!tree) { throw new Error(`${label} contains invalid JSON/JSONC: a JSON value is required.`); }
  const materialize = (node: Node): unknown => {
    if (node.type === 'array') { return (node.children || []).map(materialize); }
    if (node.type === 'object') {
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      for (const property of node.children || []) {
        const key = String(property.children?.[0].value);
        if (seen.has(key)) { throw new Error(`${label} contains a duplicate JSON key: ${key}`); }
        seen.add(key);
        // Ordinary assignment invokes the __proto__ setter. JSON keys must stay
        // own data properties, including user metadata with that literal name.
        Object.defineProperty(result, key, {
          value: materialize(property.children![1]), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    }
    return node.value;
  };
  return materialize(tree);
}

interface Fence { start: number; end: number; contentStart: number; contentEnd: number; content: string; value: unknown }
function findRegistry(text: string): Fence | null {
  const fences: Fence[] = [];
  // Ignore nested-looking fences inside another fenced block.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const scannedLine = offset === 0 ? line.replace(/^\uFEFF/, '') : line;
    const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(scannedLine);
    if (!open) { offset += line.length; continue; }
    const start = offset + (offset === 0 && line.startsWith('\uFEFF') ? 1 : 0);
    const marker = open[1][0];
    const count = open[1].length;
    const language = open[2].trim().toLowerCase();
    const contentStart = offset + line.length;
    offset += line.length;
    let content = '';
    let closed = false;
    let contentEnd = offset;
    for (index++; index < lines.length; index++) {
      const current = lines[index];
      const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${count},}\\s*$`);
      if (close.test(current.trimEnd())) {
        contentEnd = offset;
        offset += current.length;
        closed = true;
        break;
      }
      content += current;
      offset += current.length;
    }
    if (language !== 'json' && language !== 'jsonc') { continue; }
    const partial = parse(content, [], { allowTrailingComma: true, disallowComments: false });
    const hint = /(?:"(?:submodules|shared_resources)"|\b(?:submodules|shared_resources))\s*:/.test(content)
      || (safeObject(partial) && (Object.hasOwn(partial, 'submodules') || Object.hasOwn(partial, 'shared_resources')));
    let value: unknown;
    try { value = parseJsoncStrict(content, 'AGENTS registry'); }
    catch (error) { if (hint) { throw error; } continue; }
    if (!safeObject(value) || (!Object.hasOwn(value, 'submodules') && !Object.hasOwn(value, 'shared_resources'))) { continue; }
    if (!closed) { throw new Error('The AGENTS registry JSON fence is not closed.'); }
    fences.push({ start, end: offset, contentStart, contentEnd, content, value });
  }
  if (fences.length > 1) { throw new Error('AGENTS.md contains multiple scope registries. Keep exactly one relevant JSON/JSONC fence.'); }
  return fences[0] || null;
}

function readPathArray(value: unknown, label: string): string[] {
  if (value === undefined) { return []; }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) { throw new Error(`${label} must be an array of literal path strings.`); }
  return value as string[];
}

function coerceRegistry(value: unknown): Registry {
  if (!safeObject(value)) {
    throw new Error('The AGENTS registry must contain shared_resources and submodules objects.');
  }
  const resources = ownValue(value, 'shared_resources');
  const entries = ownValue(value, 'submodules');
  if (!safeObject(entries) || !safeObject(resources)) {
    throw new Error('The AGENTS registry must contain shared_resources and submodules objects.');
  }
  const modules: Record<string, ModuleConfig> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!safeObject(entry)) { throw new Error(`The configuration for ${name} must be an object.`); }
    if (['__proto__', 'prototype', 'constructor'].includes(name)) { throw new Error(`Unsupported module name: ${name}`); }
    modules[name] = {
      ...entry,
      path: ownValue(entry, 'path') as string,
      enabled: ownValue(entry, 'enabled') === true,
      restrict_paths: typeof ownValue(entry, 'restrict_paths') === 'boolean' ? ownValue(entry, 'restrict_paths') as boolean : true,
      read_paths: readPathArray(ownValue(entry, 'read_paths'), `${name}.read_paths`),
      write_paths: readPathArray(ownValue(entry, 'write_paths'), `${name}.write_paths`),
      instruction_file: ownValue(entry, 'instruction_file') === undefined ? null : ownValue(entry, 'instruction_file') as string | null,
    };
  }
  const registry: Registry = {
    ...value,
    shared_resources: {
      ...resources,
      read_paths: readPathArray(ownValue(resources, 'read_paths'), 'shared_resources.read_paths'),
      write_paths: readPathArray(ownValue(resources, 'write_paths'), 'shared_resources.write_paths'),
    },
    submodules: modules,
  };
  validateRegistry(registry);
  return registry;
}

export function readAgentsRegistry(text: string): Registry | null {
  const fence = findRegistry(text);
  return fence ? coerceRegistry(fence.value) : null;
}

function overlaps(first: string, second: string): boolean {
  if (process.platform === 'win32') { first = first.toLowerCase(); second = second.toLowerCase(); }
  return first === second || first === '.' || second === '.' || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

function contains(first: string, second: string): boolean {
  if (process.platform === 'win32') { first = first.toLowerCase(); second = second.toLowerCase(); }
  return first === '.' || first === second || second.startsWith(`${first}/`);
}

export function validateRegistry(registry: Registry, root?: string): void {
  if (!safeObject(registry) || !safeObject(registry.shared_resources) || !safeObject(registry.submodules)) {
    throw new Error('A scope registry requires shared_resources and submodules objects.');
  }
  const modules: Array<[string, ModuleConfig, string]> = [];
  for (const [name, module] of Object.entries(registry.submodules)) {
    if (!name.trim() || /[\x00-\x1f\x7f]/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name) || !safeObject(module)) {
      throw new Error(`Invalid project name or configuration: ${name}`);
    }
    if (typeof module.enabled !== 'boolean' || typeof module.restrict_paths !== 'boolean') { throw new Error(`${name}: enabled and restrict_paths must be true or false.`); }
    const modulePath = normalizeRelative(module.path);
    rejectGitMetadata(modulePath);
    if (modules.some(([, , existing]) => overlaps(existing, modulePath))) { throw new Error(`Project roots overlap: ${modulePath}. Overlaps could bypass a disabled project.`); }
    for (const field of resourceFields) {
      if (!Array.isArray(module[field])) { throw new Error(`${name}.${field} must be an array of literal path strings.`); }
      for (const value of readPathArray(module[field], `${name}.${field}`)) {
        rejectGitMetadata(normalizeRelative(value));
        if (root) { resolveContained(resolveContained(root, modulePath), value); }
      }
    }
    if (module.instruction_file !== null && typeof module.instruction_file !== 'string') { throw new Error(`${name}.instruction_file must be a relative path or null.`); }
    if (module.instruction_file !== null) { normalizeRelative(module.instruction_file); }
    if (root) { resolveContained(root, modulePath); }
    modules.push([name, module, modulePath]);
  }
  const sharedRead: string[] = [];
  for (const field of resourceFields) {
    if (!Array.isArray(registry.shared_resources[field])) { throw new Error(`shared_resources.${field} must be an array of literal path strings.`); }
    for (const value of readPathArray(registry.shared_resources[field], `shared_resources.${field}`)) {
      const normalized = normalizeRelative(value);
      rejectGitMetadata(normalized);
      if (modules.some(([, , modulePath]) => overlaps(normalized, modulePath))) { throw new Error(`Shared resource overlaps a registered project: ${value}`); }
      if (root) { resolveContained(root, normalized); }
      sharedRead.push(normalized);
    }
  }
  const effectiveRead = [...sharedRead];
  for (const [, module, modulePath] of modules) {
    if (!module.enabled) { continue; }
    if (!module.restrict_paths) { effectiveRead.push(modulePath); }
    else {
      for (const value of [...module.read_paths, ...module.write_paths]) {
        const relative = normalizeRelative(value);
        effectiveRead.push(normalizeRelative(`${modulePath}/${relative}`));
      }
    }
  }
  for (const [name, module] of modules) {
    if (module.enabled && module.instruction_file !== null && !effectiveRead.some(scope => contains(scope, normalizeRelative(module.instruction_file!)))) {
      throw new Error(`${name}: the selected instruction_file is outside effective readable paths. Add a matching read scope first.`);
    }
  }
}

function formatting(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const indent = /\n([ \t]+)"/.exec(text)?.[1];
  return { insertSpaces: !indent?.includes('\t'), tabSize: indent && !indent.includes('\t') ? indent.length : 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

const managedRules = `<!-- BEGIN AgentScope managed instructions -->
## AgentScope access registry

The JSON settings below define behavioral project access, not executable access controls. WORKSPACE_ROOT is the directory containing this file. Module paths and shared resource paths are relative to WORKSPACE_ROOT; each module's read_paths and write_paths are relative to its own path. Literal paths only; "." means that selected root. Resolve symbolic links and junctions and reject escapes before access.

enabled=false grants no default project or Git access. For enabled projects, restrict_paths=false permits task-required reads and writes in the project; restrict_paths=true limits reads to read_paths plus write_paths and writes to write_paths. Empty lists grant no access. Shared resources must stay outside all registered projects and cannot enable disabled projects. Access never authorizes unrelated changes. Malformed settings must fail closed.

Search, list and edit only permitted paths, targeting allowed subtrees directly. Do not recursively discover content from the workspace root or a broader project root. This policy and governing agent instructions may be read; edit policy only when explicitly requested. Read .gitmodules only for an authorized registration or Git task. A reference or local policy does not expand access.

For each involved enabled project, read its non-null instruction_file before applying that additional workflow; it must already be in readable scope. Do not load all readable workflows. An explicit user workflow selection overrides this default for the current task without changing persistent settings, higher-priority rules or filesystem permissions.

Git access is limited to authorized task operations in the selected repository. Verify its .git pointer stays in that repository or WORKSPACE_ROOT/.git/modules/<registered name>; any other destination needs explicit authorization. Metadata writes are allowed only for authorized staging, commits, fetches or pushes. Stage only task-related writable files; preserve unrelated changes. Commit or push only when explicitly authorized. Parent Git and submodule-reference changes need their own authorization.

Tool infrastructure and governing instructions may be read as required; this does not grant access to unrelated project data. Explicit user instructions may grant a narrow temporary exception; do not persist it without a request. Identify a required outside path and purpose before requesting missing access. Technical sandbox settings are separate; a new session may be needed after settings changes.
<!-- END AgentScope managed instructions -->`;

export function writeAgentsRegistry(text: string, registry: Registry): string {
  validateRegistry(registry);
  const fence = findRegistry(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!fence) {
    const separator = text.length === 0 ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
    return `${text}${separator}${managedRules.replace(/\n/g, eol)}${eol}${eol}\`\`\`json${eol}${JSON.stringify(registry, null, 2).replace(/\n/g, eol)}${eol}\`\`\`${eol}`;
  }
  const previous = coerceRegistry(fence.value);
  let content = fence.content;
  const set = (jsonPath: string[], value: unknown): void => {
    content = applyEdits(content, modify(content, jsonPath, value, { formattingOptions: formatting(content) }));
  };
  for (const field of resourceFields) { if (JSON.stringify(previous.shared_resources[field]) !== JSON.stringify(registry.shared_resources[field])) { set(['shared_resources', field], registry.shared_resources[field]); } }
  for (const name of Object.keys(previous.submodules)) { if (!Object.hasOwn(registry.submodules, name)) { set(['submodules', name], undefined); } }
  for (const [name, module] of Object.entries(registry.submodules)) {
    if (!Object.hasOwn(previous.submodules, name)) { set(['submodules', name], module); continue; }
    for (const field of moduleFields) {
      // Persist fail-closed defaults even when the input omitted those fields.
      const raw = (fence.value as Registry).submodules[name];
      if (JSON.stringify(raw[field]) !== JSON.stringify(module[field])) { set(['submodules', name, field], module[field]); }
    }
  }
  return text.slice(0, fence.contentStart) + content + text.slice(fence.contentEnd);
}

export const ACCESS_POLICY_FILE = '.agentscope/access.md';

const accessReferenceV050 = `<!-- BEGIN AgentScope access reference -->
Before reading, searching or editing workspace files, read and follow [the AgentScope access policy](.agentscope/access.md). If that file is missing, invalid or unreadable, stop and request a valid policy before accessing project files. This policy does not replace other governing instructions or executable access controls.
<!-- END AgentScope access reference -->`;

const accessReference = accessReferenceV050.replace(
  'This policy does not replace other governing instructions or executable access controls.',
  'The linked file is the sole source of AgentScope access settings. Earlier inline AgentScope registries in this file are retained only as historical references and must not be used to grant access. This policy does not replace other governing instructions or executable access controls.',
);

const accessRules = managedRules
  .replaceAll('AgentScope managed instructions', 'AgentScope access policy')
  .replace('WORKSPACE_ROOT is the directory containing this file.', 'WORKSPACE_ROOT is the workspace root: the parent of the .agentscope directory containing this file.');

type ManagedKind = 'managed instructions' | 'access reference' | 'access policy';
interface ManagedBlock { start: number; end: number; lineEnd: number }
interface AccessSource {
  reference: ManagedBlock | null;
  legacy: ManagedBlock | null;
  mainFence: Fence | null;
  accessFence: Fence | null;
}

/** Markers appearing in fenced examples belong to user prose, not to AgentScope. */
function managedBlocks(text: string, label: string): Map<ManagedKind, ManagedBlock> {
  const result = new Map<ManagedKind, ManagedBlock>();
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  let fenced: { marker: string; count: number } | null = null;
  let pending: { kind: ManagedKind; start: number } | null = null;
  for (const raw of lines) {
    const bomLength = offset === 0 && raw.startsWith('\uFEFF') ? 1 : 0;
    const line = raw.slice(bomLength).replace(/\r?\n$/, '');
    if (fenced) {
      if (new RegExp(`^ {0,3}${fenced.marker}{${fenced.count},}[ \\t]*$`).test(line)) { fenced = null; }
      offset += raw.length;
      continue;
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (openingFence) {
      fenced = { marker: openingFence[1][0], count: openingFence[1].length };
      offset += raw.length;
      continue;
    }
    if (/<!--\s*(?:BEGIN|END)\s+AgentScope\b/.test(line)) {
      const match = /^ {0,3}<!-- (BEGIN|END) AgentScope (managed instructions|access reference|access policy) -->[ \t]*$/.exec(line);
      if (!match) { throw new Error(`${label} contains a malformed AgentScope marker. Repair the managed block before applying changes; existing content was preserved.`); }
      const kind = match[2] as ManagedKind;
      if (match[1] === 'BEGIN') {
        if (pending || result.has(kind)) { throw new Error(`${label} contains duplicate or nested AgentScope markers. Keep exactly one complete managed block; existing content was preserved.`); }
        pending = { kind, start: offset + bomLength };
      } else {
        if (!pending || pending.kind !== kind) { throw new Error(`${label} contains an unmatched AgentScope end marker. Repair the managed block before applying changes; existing content was preserved.`); }
        result.set(kind, { start: pending.start, end: offset + bomLength + line.length, lineEnd: offset + raw.length });
        pending = null;
      }
    }
    offset += raw.length;
  }
  if (pending) { throw new Error(`${label} contains an unclosed AgentScope managed block. Repair its end marker before applying changes; existing content was preserved.`); }
  return result;
}

function requireOwnedRules(text: string, block: ManagedBlock, expected: string, label: string): void {
  if (text.slice(block.start, block.end).replace(/\r\n/g, '\n') !== expected) {
    throw new Error(`${label} contains customized AgentScope policy instructions. Move custom instructions outside the managed block and restore its original text before applying changes; existing content was preserved.`);
  }
}

function requireAssociatedFence(text: string, block: ManagedBlock, fence: Fence | null, label: string): Fence {
  if (!fence || fence.start < block.lineEnd || text.slice(block.lineEnd, fence.start).trim() !== '') {
    throw new Error(`${label} must have exactly one valid registry JSON/JSONC fence immediately after its managed policy block. Repair the policy before applying changes; existing content was preserved.`);
  }
  coerceRegistry(fence.value);
  return fence;
}

function inspectAccessSource(agentsText: string, accessText: string | null): AccessSource {
  const mainBlocks = managedBlocks(agentsText, 'AGENTS.md');
  const reference = mainBlocks.get('access reference') || null;
  const legacy = mainBlocks.get('managed instructions') || null;
  if (mainBlocks.has('access policy')) { throw new Error(`The managed access policy belongs in ${ACCESS_POLICY_FILE}, not AGENTS.md. Move it there before applying changes; existing content was preserved.`); }
  let historicalInline = false;
  if (reference) {
    const wording = agentsText.slice(reference.start, reference.end).replace(/\r\n/g, '\n');
    if (wording !== accessReferenceV050 && wording !== accessReference) {
      throw new Error('AGENTS.md contains customized AgentScope access reference instructions. Move custom text outside the access reference markers and restore the original generated reference before applying changes; existing content was preserved.');
    }
    historicalInline = wording === accessReference;
  }
  // A recognized current reference makes the linked file authoritative. Historical
  // inline settings are never parsed, combined with it or used as a fallback.
  const mainFence = historicalInline ? null : findRegistry(agentsText);
  if (legacy && !historicalInline) {
    requireOwnedRules(agentsText, legacy, managedRules, 'AGENTS.md');
    requireAssociatedFence(agentsText, legacy, mainFence, 'AGENTS.md');
  }
  if (reference && !historicalInline && (legacy || mainFence)) {
    throw new Error(`AGENTS.md contains both an access reference and an inline registry. Keep only one authoritative policy after reviewing the conflicting data; existing content was preserved.`);
  }
  let accessFence: Fence | null = null;
  if (accessText !== null) {
    const sideBlocks = managedBlocks(accessText, ACCESS_POLICY_FILE);
    const policy = sideBlocks.get('access policy');
    if (!policy || sideBlocks.size !== 1) {
      throw new Error(`${ACCESS_POLICY_FILE} already exists without a valid AgentScope managed policy. Move or rename this user-owned file before applying changes; existing content was preserved.`);
    }
    requireOwnedRules(accessText, policy, accessRules, ACCESS_POLICY_FILE);
    accessFence = requireAssociatedFence(accessText, policy, findRegistry(accessText), ACCESS_POLICY_FILE);
    if (!historicalInline && (mainFence || legacy)) {
      throw new Error(`Both AGENTS.md and ${ACCESS_POLICY_FILE} contain access registries. Review them and keep one authoritative policy before applying changes; existing content was preserved.`);
    }
  } else if (reference) {
    throw new Error(`AGENTS.md references ${ACCESS_POLICY_FILE}, but that file is missing. Use "Recover saved configuration" to restore saved access settings, or "Reconfigure access" to choose new scopes. Project access stays blocked until a valid policy is applied.`);
  }
  return { reference, legacy, mainFence, accessFence };
}

/** Checks the reserved reference markers; recognized generated wording can be refreshed. */
export function isAccessReference(agentsText: string): boolean {
  return managedBlocks(agentsText, 'AGENTS.md').has('access reference');
}

/** Reads the separate policy when present, or an unmigrated inline registry. */
export function readAccessRegistry(agentsText: string, accessText: string | null): Registry | null {
  const source = inspectAccessSource(agentsText, accessText);
  const fence = source.accessFence || source.mainFence;
  return fence ? coerceRegistry(fence.value) : null;
}

/** Preserve JSONC annotations when importing a legacy registry into editor storage. */
export function legacyRegistryJsonc(agentsText: string, accessText: string | null): string | null {
  const source = inspectAccessSource(agentsText, accessText);
  return (source.accessFence || source.mainFence)?.content ?? null;
}

/** One-time migration removes only canonical generated instructions, preserving user prose. */
export function detachLegacyInstructions(agentsText: string, accessText: string | null): string {
  const source = inspectAccessSource(agentsText, accessText);
  const spans: Array<{ start: number; end: number }> = [];
  if (source.reference) spans.push(source.reference);
  if (source.legacy) {
    requireOwnedRules(agentsText, source.legacy, managedRules, 'AGENTS.md');
    const fence = requireAssociatedFence(agentsText, source.legacy, findRegistry(agentsText), 'AGENTS.md');
    spans.push(source.legacy, fence);
  }
  return spans.sort((a, b) => b.start - a.start).reduce((text, span) => text.slice(0, span.start) + text.slice(span.end), agentsText);
}

function prependAccessReference(text: string, reference: ManagedBlock | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = accessReference.replace(/\n/g, eol);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  if (reference?.start === bom.length) {
    // Keep the user's exact suffix, including line endings after the end marker.
    return bom + rendered + text.slice(reference.end);
  }
  const remaining = reference ? text.slice(0, reference.start) + text.slice(reference.end) : text;
  const content = remaining.slice(bom.length);
  return bom + rendered + (content.length ? `${eol}${eol}${content}` : eol);
}

/** Produces both files without modifying any user-owned prose or policy file. */
export function writeAccessFiles(agentsText: string, accessText: string | null, registry: Registry): { agents: string; access: string; warnings: string[] } {
  validateRegistry(registry);
  const source = inspectAccessSource(agentsText, accessText);
  const eol = agentsText.includes('\r\n') ? '\r\n' : '\n';
  const warnings: string[] = [];
  let access = accessText;
  if (source.mainFence) {
    if (!source.legacy) {
      throw new Error('AGENTS.md contains a user-owned inline access registry without the original AgentScope managed instructions. AgentScope will not copy or reinterpret it automatically. Review and migrate that registry explicitly before applying changes; existing content was preserved.');
    }
    const { mainFence } = source;
    access = accessRules.replace(/\n/g, eol) + `${eol}${eol}` + agentsText.slice(mainFence.start, mainFence.end);
    // Copy the registry instead of deleting any existing instructions or settings.
    // The new reference explicitly labels the unchanged inline data as historical.
    warnings.push(`Copied the AgentScope-owned inline registry to ${ACCESS_POLICY_FILE}; all original AGENTS.md text and JSONC comments were retained as historical reference.`);
  }
  if (access === null) {
    access = writeAgentsRegistry('', registry)
      .replace(managedRules, accessRules)
      .replace(/\n/g, eol);
  } else {
    access = writeAgentsRegistry(access, registry);
  }
  return { agents: prependAccessReference(agentsText, source.reference), access, warnings };
}

/** Retain damaged/custom controls as historical comments, without touching fenced examples. */
function historicalControlMarkers(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let fenced: { marker: string; count: number } | null = null;
  return lines.map((raw, index) => {
    const line = (index === 0 ? raw.replace(/^\uFEFF/, '') : raw).replace(/\r?\n$/, '');
    if (fenced) {
      if (new RegExp(`^ {0,3}${fenced.marker}{${fenced.count},}[ \\t]*$`).test(line)) fenced = null;
      return raw;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (opening) {
      fenced = { marker: opening[1][0], count: opening[1].length };
      return raw;
    }
    return raw.replace(/<!--\s*(BEGIN|END)\s+AgentScope\b/g, '<!-- Historical AgentScope $1');
  }).join('');
}

/** Explicit reconfiguration rebuilds access data while retaining all existing main-file prose. */
export function writeReconfiguredAccessFiles(agentsText: string, registry: Registry): { agents: string; access: string; warnings: string[] } {
  const clean = writeAccessFiles('', null, registry);
  // Match the user's existing newline convention for the new managed policy.
  const access = agentsText.includes('\r\n') ? clean.access.replace(/\n/g, '\r\n') : clean.access;
  let reference: ManagedBlock | null = null;
  try {
    reference = managedBlocks(agentsText, 'AGENTS.md').get('access reference') || null;
    if (reference) {
      const wording = agentsText.slice(reference.start, reference.end).replace(/\r\n/g, '\n');
      if (wording !== accessReference && wording !== accessReferenceV050) reference = null;
    }
    const agents = prependAccessReference(agentsText, reference);
    // Historical inline JSON is not parsed after canonical delegation. All
    // retained structural markers must nevertheless be valid or neutralized.
    readAccessRegistry(agents, access);
    return { agents, access, warnings: [`Rebuilt ${ACCESS_POLICY_FILE} from the current selections; existing AGENTS.md instructions were retained.`] };
  } catch {
    const preserved = historicalControlMarkers(agentsText);
    const agents = prependAccessReference(preserved, null);
    readAccessRegistry(agents, access);
    return {
      agents, access,
      warnings: [`Rebuilt ${ACCESS_POLICY_FILE} from the current selections. Existing AGENTS.md text was retained; damaged or customized AgentScope markers were relabeled as historical comments.`],
    };
  }
}

/** Git removes continued newlines and comments before decoding a value. */
function gitStatements(source: string): string[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const result: string[] = [];
  let value = '';
  let quoted = false;
  let comment = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\r' || character === '\0') { throw new Error('Invalid control character in .gitmodules.'); }
    if (comment) {
      if (character !== '\n') { continue; }
      comment = false;
    } else if (character === '\\') {
      if (text[index + 1] === '\n') { index++; continue; }
      if (index + 1 === text.length) { throw new Error('Incomplete escape in .gitmodules.'); }
      value += character + text[++index];
      continue;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === '#' || character === ';')) {
      comment = true;
      continue;
    }
    if (character === '\n') {
      if (quoted) { throw new Error('Unclosed quoted value in .gitmodules.'); }
      if (value.trim()) { result.push(value.trim()); }
      value = '';
    } else { value += character; }
  }
  if (quoted) { throw new Error('Unclosed quoted value in .gitmodules.'); }
  if (value.trim()) { result.push(value.trim()); }
  return result;
}

function decodeGitValue(value: string): string {
  const output: { character: string; protected: boolean }[] = [];
  const escapes: Record<string, string> = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' };
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"') { quoted = !quoted; continue; }
    if (character === '\\') {
      const escaped = value[++index];
      if (!Object.hasOwn(escapes, escaped)) { throw new Error(`Unsupported escape in .gitmodules: \\${escaped || ''}`); }
      output.push({ character: escapes[escaped], protected: true });
    } else { output.push({ character, protected: quoted }); }
  }
  if (quoted) { throw new Error('Unclosed quoted value in .gitmodules.'); }
  while (output.length && !output[0].protected && /\s/.test(output[0].character)) { output.shift(); }
  while (output.length && !output[output.length - 1].protected && /\s/.test(output[output.length - 1].character)) { output.pop(); }
  return output.map(part => part.character).join('');
}

function decodeGitSubsection(value: string): string {
  // Git's subsection escapes differ from value escapes: backslash escapes the
  // following character literally, including a letter such as n or t.
  return value.replace(/\\(.)/g, '$1');
}

export function parseGitmodules(text: string): DiscoveredModule[] {
  const modules = new Map<string, string>();
  const names = new Set<string>();
  let selected: string | null = null;
  let sectionSeen = false;
  for (const line of gitStatements(text)) {
    if (line.startsWith('[')) {
      const section = /^\[([A-Za-z0-9-]+)(?:\s+"((?:[^"\\]|\\.)*)"|\.([A-Za-z0-9.-]+))?\s*\]$/.exec(line);
      if (!section) { throw new Error('Malformed or unsupported section in .gitmodules.'); }
      const kind = section[1].toLowerCase();
      if (kind === 'include' || kind === 'includeif') { throw new Error('Includes are unsupported in .gitmodules; declare submodule paths directly in this file.'); }
      const subsection = section[2] !== undefined ? decodeGitSubsection(section[2]) : section[3]?.toLowerCase();
      selected = kind === 'submodule' ? subsection ?? null : null;
      sectionSeen = true;
      if (kind === 'submodule' && selected === null) { throw new Error('A submodule section in .gitmodules requires a name.'); }
      if (selected !== null) {
        if (!selected || ['__proto__', 'prototype', 'constructor'].includes(selected) || normalizeRelative(selected) === '.') { throw new Error('Invalid submodule name in .gitmodules.'); }
        names.add(selected);
      }
      continue;
    }
    const setting = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.*))?$/.exec(line);
    if (!sectionSeen || !setting) { throw new Error('Malformed setting in .gitmodules.'); }
    const value = setting[2] === undefined ? undefined : decodeGitValue(setting[2]);
    if (selected !== null && setting[1].toLowerCase() === 'path') {
      if (modules.has(selected)) { throw new Error(`Duplicate submodule path setting: ${selected}`); }
      if (value === undefined || !value) { throw new Error(`A submodule path must be a nonempty value: ${selected}`); }
      if (value.includes('\\')) { throw new Error(`Use portable forward slashes in .gitmodules paths: ${selected}`); }
      modules.set(selected, normalizeRelative(value));
    }
  }
  for (const name of names) {
    if (!modules.has(name)) { throw new Error(`Missing submodule path in .gitmodules: ${name}`); }
  }
  const seenPaths = new Set<string>();
  return [...modules].map(([name, modulePath]) => {
    if (modulePath === '.' || seenPaths.has(modulePath)) { throw new Error(`Duplicate or invalid submodule root: ${modulePath}`); }
    seenPaths.add(modulePath);
    return { name, path: modulePath };
  });
}
