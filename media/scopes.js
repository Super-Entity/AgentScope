(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const body = document.getElementById('rows');
  const status = document.getElementById('status');
  const preset = document.getElementById('preset');
  const notice = document.getElementById('notice');
  const configurationActions = document.getElementById('configuration-actions');
  const workspace = document.getElementById('workspace');
  const collapseAllButton = document.getElementById('collapse-all');
  const menus = [...document.querySelectorAll('.toolbar .more')];
  const nodes = new Map();
  const rowElements = new Map();
  let model = null;
  let requestCounter = 0;
  let pendingMutation = false;
  let focusedKey = null;
  let desiredFocus = null;

  const nodeKey = (name, relative, target = 'project') => JSON.stringify([target, name, relative]);
  const resourceRow = row => row.target === 'resource';
  const resourceRoot = row => resourceRow(row) && row.relative === '.';
  const targetMessage = row => resourceRow(row) ? { target: 'resource' } : {};
  const normalized = value => value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/') || '.';
  const compare = value => model && !model.caseSensitive ? value.toLowerCase() : value;
  const contains = (ancestor, target) => ancestor === '.' || compare(ancestor) === compare(target) || compare(target).startsWith(`${compare(ancestor)}/`);
  const readOnlyCommands = new Set(['refresh', 'selectWorkspace', 'preview', 'openAgents', 'openAccess', 'openCodex']);
  const configurationErrorCommands = new Set(['refresh', 'selectWorkspace', 'openAgents', 'openAccess', 'openCodex', 'restore', 'recover', 'reconfigure']);

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function unavailable(command) {
    return !model || model.busy || pendingMutation || (!model.workspace && command !== 'selectWorkspace' && command !== 'refresh') ||
      (command === 'recover' && model.recoveryAvailable !== true) ||
      (command === 'restore' && model.restoreAvailable !== true) ||
      (Boolean(model.configurationError) && !configurationErrorCommands.has(command)) || (!model.trusted && !readOnlyCommands.has(command));
  }

  function command(name, projectName, details = {}) {
    if (unavailable(name)) return;
    vscode.postMessage({ type: 'command', workspaceId: model.workspaceId, command: name, ...(projectName === undefined ? {} : { name: projectName }), ...details });
  }

  function closeMenus(except = null, restoreFocus = false) {
    let opener = null;
    for (const menu of menus) {
      if (menu === except) continue;
      const summary = menu.querySelector('summary');
      if (menu.open && menu.contains(document.activeElement)) opener = summary;
      menu.open = false;
      summary.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus && opener) opener.focus();
  }

  function selection(row, access) {
    if (resourceRoot(row)) return row[access];
    const project = resourceRow(row) ? model.resources : model.projects.find(item => item.name === row.name);
    if (!project || !project.scope) return row[access];
    const scope = project.scope;
    if (!scope.enabled) return { checked: false, partial: false, inherited: false };
    const scopes = scope.restrict_paths === false ? ['.'] : (access === 'write' ? scope.write_paths : [...scope.read_paths, ...scope.write_paths]).map(normalized);
    const target = normalized(row.relative);
    const covering = scopes.filter(path => contains(path, target));
    return { checked: covering.length > 0, partial: !covering.length && scopes.some(path => contains(target, path)), inherited: covering.some(path => compare(path) !== compare(target)) };
  }

  function ensureNode(row) {
    const key = nodeKey(row.name, row.relative, row.target);
    let node = nodes.get(key);
    if (!node) {
      node = { key, row, expanded: false, loaded: false, loading: false, error: '', children: [], requestId: null };
      nodes.set(key, node);
    }
    node.row = row;
    return node;
  }

  function requestChildren(node) {
    if (!model || model.configurationError || model.busy || node.loading || !node.row.directory) return;
    node.loading = true;
    node.error = '';
    node.requestId = ++requestCounter;
    vscode.postMessage({ type: 'children', workspaceId: model.workspaceId, name: node.row.name, relative: node.row.relative, requestId: node.requestId, ...targetMessage(node.row) });
  }

  function expand(node) {
    if (!node.row.directory || !model || model.configurationError || model.busy || pendingMutation) return;
    node.expanded = !node.expanded;
    if (node.expanded && !node.loaded) requestChildren(node);
    render();
  }

  function collapseAll() {
    if (!model || !model.workspace || model.configurationError) return;
    const active = document.activeElement;
    const activeRow = active && active.closest ? active.closest('tr[data-key]') : null;
    const focused = nodes.get(activeRow ? activeRow.dataset.key : focusedKey);
    const rootKey = focused ? nodeKey(focused.row.name, '.', focused.row.target) : null;
    for (const node of nodes.values()) node.expanded = false;
    if (rootKey && nodes.has(rootKey)) {
      focusedKey = rootKey;
      render({ key: rootKey });
    } else render();
  }

  function checkbox(row, access) {
    const state = selection(row, access);
    const input = element('input', 'permission');
    input.type = 'checkbox';
    input.dataset.access = access;
    input.checked = Boolean(state.checked);
    input.indeterminate = Boolean(state.partial);
    input.disabled = row.selectable === false || !model.trusted || Boolean(model.configurationError) || model.busy || pendingMutation;
    const pathLabel = row.project ? row.label : resourceRow(row) ? `Workspace: ${row.relative}` : `${row.name}: ${row.relative}`;
    input.setAttribute('aria-label', `${access === 'read' ? 'Read' : 'Write'} access for ${pathLabel}`);
    input.title = row.selectable === false ? 'Contains a registered project; select individual workspace paths below' : state.partial ? 'Some descendants are selected' : state.inherited ? 'Included by a selected ancestor' : access === 'write' ? 'Writing also permits reading' : 'Permit reading this path';
    input.addEventListener('change', () => {
      if (!model || row.selectable === false || !model.trusted || model.configurationError || model.busy || pendingMutation) { render(); return; }
      const checked = input.checked;
      pendingMutation = true;
      focusedKey = nodeKey(row.name, row.relative, row.target);
      vscode.postMessage({ type: 'toggle', workspaceId: model.workspaceId, name: row.name, relative: row.relative, access, checked, directory: row.directory, ...targetMessage(row) });
      render();
    });
    return input;
  }

  function actionButton(label, action, projectName, title, details = {}) {
    const button = element('button', 'row-action', label);
    button.dataset.action = action;
    button.title = title;
    button.setAttribute('aria-label', `${title} for ${details.relative === undefined ? projectName : `Workspace: ${details.relative}`}`);
    button.disabled = unavailable(action);
    button.addEventListener('click', () => command(action, projectName, details));
    return button;
  }

  function appendNode(fragment, node, depth) {
    const row = node.row;
    const tr = element('tr', row.project ? 'project-row' : resourceRoot(row) ? 'resource-root-row' : 'path-row');
    tr.dataset.key = node.key;
    tr.tabIndex = focusedKey === node.key ? 0 : -1;
    tr.setAttribute('aria-level', String(depth + 1));
    if (row.directory) tr.setAttribute('aria-expanded', String(node.expanded));
    tr.addEventListener('focus', () => {
      focusedKey = node.key;
      if (desiredFocus && desiredFocus.key !== node.key) desiredFocus = null;
    });
    tr.addEventListener('keydown', event => navigate(event, node));
    const labelCell = element('td', 'name-cell');
    const label = element('div', 'name-content');
    for (let index = 0; index < Math.min(depth, 80); index++) label.append(element('span', 'indent'));
    if (row.directory) {
      const expander = element('button', 'expander', node.expanded ? '▾' : '▸');
      expander.dataset.action = 'expand';
      expander.setAttribute('aria-label', `${node.expanded ? 'Collapse' : 'Expand'} ${row.label}`);
      expander.setAttribute('aria-expanded', String(node.expanded));
      expander.disabled = Boolean(model.configurationError) || model.busy || pendingMutation;
      expander.addEventListener('click', () => expand(node));
      label.append(expander);
    } else label.append(element('span', 'file-spacer'));
    const text = element('span', 'path-label', row.label);
    text.title = `${resourceRow(row) ? 'Workspace' : row.name}: ${row.relative}${row.symbolicLink ? ' (symbolic link or junction)' : ''}`;
    label.append(text);
    const read = selection(row, 'read');
    const write = selection(row, 'write');
    if (read.partial || write.partial) label.append(element('span', 'badge', 'Some selected'));
    if (row.project && row.enabled === false) label.append(element('span', 'badge disabled-badge', 'Disabled'));
    if (resourceRow(row) && !resourceRoot(row) && row.selectable === false) label.append(element('span', 'badge', 'Expand to select'));
    labelCell.append(label);
    tr.append(labelCell);
    for (const access of ['read', 'write']) {
      const cell = element('td', 'permission-cell');
      cell.append(checkbox(row, access));
      tr.append(cell);
    }
    const actions = element('td', 'actions-cell');
    if (row.project) {
      actions.append(actionButton(row.enabled ? 'Disable' : 'Enable', 'toggleAccess', row.name, row.enabled ? 'Disable project without clearing saved path selections' : 'Enable saved project path selections'));
      actions.append(actionButton('⋯', 'configure', row.name, 'Configure paths and instruction file'));
      if (!row.scope || row.scope.path !== '.') actions.append(actionButton(row.hidden ? 'Show' : 'Hide', 'toggleVisibility', row.name, row.hidden ? 'Show folder in Explorer' : 'Hide folder in Explorer'));
    } else if (resourceRow(row) && row.selectable !== false && !resourceRoot(row)) {
      const hidden = model.resourceHidden ? model.resourceHidden[row.relative] === true : row.hidden === true;
      actions.append(actionButton(hidden ? 'Show' : 'Hide', 'toggleResourceVisibility', row.name, hidden ? 'Show path in Explorer' : 'Hide path in Explorer', { target: 'resource', relative: row.relative }));
    }
    tr.append(actions);
    rowElements.set(node.key, tr);
    fragment.append(tr);
    if (!node.expanded) return;
    if (node.loading || node.error || (node.loaded && !node.children.length)) {
      const info = element('tr', 'info-row');
      const cell = element('td', 'info-cell', node.loading ? 'Loading…' : node.error || 'No files or folders');
      cell.colSpan = 4;
      if (node.error) {
        const retry = element('button', 'retry', 'Retry');
        retry.disabled = Boolean(model.configurationError) || model.busy || pendingMutation;
        retry.addEventListener('click', () => { requestChildren(node); render(); });
        cell.append(retry);
      }
      info.append(cell);
      fragment.append(info);
    } else for (const child of node.children) appendNode(fragment, child, depth + 1);
  }

  function navigate(event, node) {
    if (event.target !== event.currentTarget) return;
    const rows = [...rowElements.entries()];
    const index = rows.findIndex(([key]) => key === node.key);
    let target;
    if (event.key === 'ArrowDown') target = rows[index + 1];
    else if (event.key === 'ArrowUp') target = rows[index - 1];
    else if (event.key === 'Home') target = rows[0];
    else if (event.key === 'End') target = rows[rows.length - 1];
    else if (event.key === 'ArrowRight') {
      if (node.row.directory && !node.expanded) { expand(node); event.preventDefault(); return; }
      if (node.row.directory && node.children.length) target = rows.find(([key]) => key === node.children[0].key);
    } else if (event.key === 'ArrowLeft') {
      if (node.expanded) { expand(node); event.preventDefault(); return; }
      const relative = node.row.relative.includes('/') ? node.row.relative.slice(0, node.row.relative.lastIndexOf('/')) : '.';
      target = rows.find(([key]) => key === nodeKey(node.row.name, relative, node.row.target) && key !== node.key);
    } else return;
    event.preventDefault();
    if (target) {
      focusedKey = target[0];
      desiredFocus = null;
      for (const [key, row] of rowElements) row.tabIndex = key === focusedKey ? 0 : -1;
      target[1].focus();
    }
  }

  function render(nextFocus) {
    if (!model) return;
    const active = document.hasFocus() ? document.activeElement : null;
    const activeRow = active && active.closest ? active.closest('tr[data-key]') : null;
    if (nextFocus) desiredFocus = nextFocus;
    else if (!activeRow) desiredFocus = null;
    else if (active.dataset.access || active.dataset.action) desiredFocus = { key: activeRow.dataset.key, access: active.dataset.access, action: active.dataset.action };
    else if (!desiredFocus) desiredFocus = { key: activeRow.dataset.key };
    workspace.textContent = model.workspace || 'Select workspace';
    workspace.title = model.workspace || 'Select the workspace folder to manage';
    status.textContent = model.busy || pendingMutation ? 'Updating…' : model.message || (model.dirty ? 'Draft changes — Preview, then Apply' : 'Saved configuration');
    if (model.configurationError) status.textContent = model.configurationError;
    preset.hidden = Boolean(model.configurationError) || typeof model.preset !== 'string' || !model.preset;
    preset.textContent = preset.hidden ? '' : `Preset: ${model.preset}${model.dirty ? ' (draft)' : ''}`;
    preset.classList.toggle('is-active', !preset.hidden && !model.dirty);
    preset.classList.toggle('is-draft', !preset.hidden && model.dirty);
    const warnings = [];
    if (!model.trusted) warnings.push('Restricted Mode: trust this workspace to change permissions.');
    if (!model.workspace) warnings.push('Open a local workspace folder to manage its permissions.');
    if (model.configurationError) warnings.push(model.trusted ? 'Use Reconfigure access to select permissions again, or recover a saved configuration from More.' : 'Trust this workspace to reconfigure or recover. Files repaired on disk are reloaded automatically.');
    notice.hidden = !warnings.length;
    notice.textContent = warnings.join(' ');
    configurationActions.hidden = !model.configurationError;
    document.getElementById('permissions').setAttribute('aria-busy', String(model.busy || pendingMutation));
    for (const button of document.querySelectorAll('[data-command]')) button.disabled = unavailable(button.dataset.command);
    for (const menu of menus) {
      const disabled = [...menu.querySelectorAll('[data-command]')].every(button => button.disabled);
      menu.querySelector('summary').setAttribute('aria-disabled', String(disabled));
      if (disabled) menu.open = false;
    }
    collapseAllButton.disabled = !model.workspace || Boolean(model.configurationError);
    const fragment = document.createDocumentFragment();
    rowElements.clear();
    const roots = model.configurationError ? [] : [...model.projects, ...(model.resources ? [model.resources] : [])];
    if (!focusedKey && roots.length) focusedKey = nodeKey(roots[0].name, roots[0].relative, roots[0].target);
    for (const root of roots) appendNode(fragment, ensureNode(root), 0);
    body.replaceChildren(fragment);
    if (!roots.length) {
      const row = element('tr', 'info-row');
      const cell = element('td', 'info-cell', model.configurationError ? 'Workspace configuration needs attention. See the error above.' : model.workspace ? 'No projects registered. Use Add to choose a folder.' : 'No workspace selected.');
      cell.colSpan = 4;
      row.append(cell);
      body.append(row);
    }
    if (desiredFocus) {
      const row = rowElements.get(desiredFocus.key);
      if (row) {
        const control = [...row.querySelectorAll('input, button')].find(item => desiredFocus.access ? item.dataset.access === desiredFocus.access : desiredFocus.action && item.dataset.action === desiredFocus.action);
        if (control && !control.disabled) { control.focus(); desiredFocus = null; }
        else row.focus();
      } else desiredFocus = null;
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
      const next = message.state;
      if (!next || !Array.isArray(next.projects) || typeof next.workspaceId !== 'number') return;
      if (!model || next.workspaceId !== model.workspaceId) {
        nodes.clear();
        focusedKey = null;
        desiredFocus = null;
      }
      model = next;
      pendingMutation = false;
      const roots = model.configurationError ? [] : [...model.projects, ...(model.resources ? [model.resources] : [])];
      const names = new Set(roots.map(row => JSON.stringify([row.target || 'project', row.name])));
      for (const [key, node] of nodes) if (!names.has(JSON.stringify([node.row.target || 'project', node.row.name]))) nodes.delete(key);
      render();
    } else if (message.type === 'children') {
      if (!model || model.configurationError || message.workspaceId !== model.workspaceId) return;
      const node = nodes.get(nodeKey(message.name, message.relative, message.target));
      if (!node || !node.loading || message.requestId !== node.requestId) return;
      node.loading = false;
      node.error = typeof message.error === 'string' ? message.error : '';
      node.loaded = !node.error;
      node.children = node.error || !Array.isArray(message.rows) ? [] : message.rows.map(ensureNode);
      render();
    }
  });

  for (const [index, menu] of menus.entries()) {
    const summary = menu.querySelector('summary');
    const actions = menu.querySelector('.more-actions');
    actions.id = `toolbar-menu-${index}`;
    actions.setAttribute('role', 'menu');
    summary.setAttribute('aria-controls', actions.id);
    summary.setAttribute('aria-haspopup', 'menu');
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', event => {
      if (summary.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      closeMenus(menu);
    });
    menu.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) closeMenus(menu);
    });
    for (const button of actions.querySelectorAll('button')) button.setAttribute('role', 'menuitem');
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (summary.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault(); closeMenus(menu); menu.open = true;
      const buttons = [...actions.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length : current) - 1;
      buttons[next].focus();
    });
  }
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.toolbar .more')) closeMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menus.some(menu => menu.open)) { event.preventDefault(); closeMenus(null, true); }
  });
  window.addEventListener('blur', () => closeMenus());
  for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => {
    closeMenus(null, true); command(button.dataset.command);
  });
  collapseAllButton.addEventListener('click', collapseAll);
  vscode.postMessage({ type: 'ready' });
})();
