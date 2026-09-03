/* global testerBrowser */
import { state } from './state.js';

const expandedIds = new Set();
const nodeRowMap = new Map(); // axNodeId → .a11y-row DOM element
let hoveredRow = null;
let hasLoadedOnce = false;

export function initA11y() {
  const panel = document.getElementById('a11yPanel');
  if (!panel || panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="a11y-toolbar">
      <button class="a11y-btn" id="a11yRefreshBtn">Refresh</button>
    </div>
    <div class="a11y-content" id="a11yContent">
      <div class="a11y-empty">Click Refresh to load the accessibility tree for this page.</div>
    </div>`;
  document.getElementById('a11yRefreshBtn').addEventListener('click', loadA11yPanel);
}

// Called after navigation — only refresh if the tree has already been loaded once,
// so the initial "Click Refresh…" empty state isn't skipped on first activation.
export function reloadA11yIfLoaded() {
  if (hasLoadedOnce) loadA11yPanel();
}

export function enableA11yHover() {
  if (!state.activeId) return;
  testerBrowser.a11y.setInspect(state.activeId, true).catch(() => {});
  testerBrowser.a11y.onNodeHovered((node) => {
    if (!node || !node.nodeId) return;
    if (hoveredRow) hoveredRow.classList.remove('a11y-hovered');
    const row = nodeRowMap.get(node.nodeId);
    if (!row) return;
    hoveredRow = row;
    row.classList.add('a11y-hovered');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

export function disableA11yHover() {
  if (!state.activeId) return;
  testerBrowser.a11y.setInspect(state.activeId, false).catch(() => {});
  testerBrowser.a11y.offNodeHovered();
  if (hoveredRow) { hoveredRow.classList.remove('a11y-hovered'); hoveredRow = null; }
}

export async function loadA11yPanel() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!state.activeId) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  hasLoadedOnce = true;
  content.innerHTML = '<div class="a11y-loading">Loading accessibility tree…</div>';
  try {
    const nodes = await testerBrowser.a11y.getTree(state.activeId);
    if (!nodes || nodes.length === 0) {
      content.innerHTML = '<div class="a11y-empty">No accessibility tree available for this page.</div>';
      return;
    }
    renderA11yTree(content, nodes);
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty">Error: ${e?.message ?? 'unknown'}</div>`;
  }
}

function renderA11yTree(panel, nodes) {
  nodeRowMap.clear();
  hoveredRow = null;
  const nodeMap = new Map();
  for (const n of nodes) nodeMap.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  if (!root) {
    panel.innerHTML = '<div class="a11y-empty">Empty tree.</div>';
    return;
  }
  panel.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'a11y-tree';
  ul.appendChild(buildNode(root, nodeMap));
  panel.appendChild(ul);
}

function buildNode(node, nodeMap) {
  const li = document.createElement('li');
  li.className = 'a11y-node';

  const hasChildren = node.childIds && node.childIds.length > 0;
  const expanded = expandedIds.has(node.nodeId);

  const row = document.createElement('div');
  row.className = 'a11y-row';

  const toggle = document.createElement('span');
  toggle.className = 'a11y-toggle';
  if (hasChildren) {
    toggle.textContent = expanded ? '▾' : '▸';
  } else {
    toggle.classList.add('a11y-toggle-leaf');
  }
  row.appendChild(toggle);

  const roleEl = document.createElement('span');
  roleEl.className = 'a11y-role';
  roleEl.textContent = node.role?.value ?? 'unknown';
  row.appendChild(roleEl);

  const name = node.name?.value;
  if (name) {
    const nameEl = document.createElement('span');
    nameEl.className = 'a11y-name';
    nameEl.textContent = `“${name}”`;
    row.appendChild(nameEl);
  }

  const desc = node.description?.value;
  if (desc) {
    const descEl = document.createElement('span');
    descEl.className = 'a11y-desc';
    descEl.textContent = desc;
    row.appendChild(descEl);
  }

  if (node.properties) {
    for (const prop of node.properties) {
      const val = prop.value?.value;
      if (val === true || (typeof val === 'string' && val && val !== 'false')) {
        const stateEl = document.createElement('span');
        stateEl.className = 'a11y-state';
        stateEl.textContent = typeof val === 'string' ? `${prop.name}=${val}` : prop.name;
        row.appendChild(stateEl);
      }
    }
  }

  nodeRowMap.set(node.nodeId, row);
  li.appendChild(row);

  if (hasChildren) {
    const childList = document.createElement('ul');
    childList.className = 'a11y-children';
    childList.style.display = expanded ? '' : 'none';
    for (const childId of node.childIds) {
      const childNode = nodeMap.get(childId);
      if (childNode) childList.appendChild(buildNode(childNode, nodeMap));
    }
    li.appendChild(childList);

    toggle.addEventListener('click', () => {
      if (expandedIds.has(node.nodeId)) {
        expandedIds.delete(node.nodeId);
        toggle.textContent = '▸';
        childList.style.display = 'none';
      } else {
        expandedIds.add(node.nodeId);
        toggle.textContent = '▾';
        childList.style.display = '';
      }
    });
  }

  return li;
}
