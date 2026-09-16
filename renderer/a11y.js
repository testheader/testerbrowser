/* global testerBrowser */
import { getActiveId } from './tabs.js';

const expandedIds = new Set();
const nodeRowMap = new Map(); // axNodeId → .a11y-row DOM element
let hoveredRow = null;
let selectedRow = null;
let inspecting = false;
let activeView = 'tree'; // 'tree' | 'violations' | 'contrast'

// One entry per view: its toolbar button id, empty-state message, whether
// it's been manually refreshed at least once (gates reloadA11yIfLoaded the
// same way the original single-view Tree panel did), and its loader.
const VIEWS = {
  tree:       { btnId: 'a11yViewTreeBtn',       emptyMsg: 'Click Refresh to load the accessibility tree for this page.',
                loaded: false, load: () => loadA11yTree() },
  violations: { btnId: 'a11yViewViolationsBtn', emptyMsg: 'Click Refresh to run an accessibility violations audit for this page.',
                loaded: false, load: () => loadA11yViolations() },
  contrast:   { btnId: 'a11yViewContrastBtn',   emptyMsg: 'Click Refresh to run a color contrast check for this page.',
                loaded: false, load: () => loadA11yContrast() },
};

export function initA11y() {
  const panel = document.getElementById('a11yPanel');
  if (!panel || panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="a11y-toolbar">
      <div class="a11y-view-toggle">
        <button class="a11y-btn on" id="a11yViewTreeBtn" data-view="tree">Tree</button>
        <button class="a11y-btn" id="a11yViewViolationsBtn" data-view="violations">Violations</button>
        <button class="a11y-btn" id="a11yViewContrastBtn" data-view="contrast">Contrast</button>
      </div>
      <button class="a11y-btn" id="a11yRefreshBtn">Refresh</button>
      <button class="a11y-btn" id="a11yInspectBtn" disabled title="Load the accessibility tree first">Inspect element</button>
      <span id="a11yInspectMsg" class="a11y-inspect-msg"></span>
    </div>
    <div class="a11y-content" id="a11yContent">
      <div class="a11y-empty">${VIEWS.tree.emptyMsg}</div>
    </div>`;
  document.getElementById('a11yRefreshBtn').addEventListener('click', () => {
    VIEWS[activeView].loaded = true;
    VIEWS[activeView].load();
  });
  document.getElementById('a11yInspectBtn').addEventListener('click', () => {
    if (inspecting) disableA11yHover(); else enableA11yHover();
  });
  for (const view of Object.keys(VIEWS)) {
    document.getElementById(VIEWS[view].btnId).addEventListener('click', () => switchA11yView(view));
  }
}

function switchA11yView(view) {
  if (view === activeView) return;
  activeView = view;
  for (const v of Object.keys(VIEWS)) {
    document.getElementById(VIEWS[v].btnId)?.classList.toggle('on', v === view);
  }
  const inspectBtn = document.getElementById('a11yInspectBtn');
  if (inspectBtn) inspectBtn.style.display = view === 'tree' ? '' : 'none';
  if (view !== 'tree' && inspecting) disableA11yHover();
  const content = document.getElementById('a11yContent');
  if (content) content.innerHTML = `<div class="a11y-empty">${VIEWS[view].emptyMsg}</div>`;
}

// Called after navigation — only refresh if the active view has already been
// loaded once, so the initial "Click Refresh…" empty state isn't skipped on
// first activation.
export function reloadA11yIfLoaded() {
  if (VIEWS[activeView].loaded) VIEWS[activeView].load();
}

export function enableA11yHover() {
  if (!getActiveId()) return;
  inspecting = true;
  document.getElementById('a11yInspectBtn')?.classList.add('on');
  testerBrowser.a11y.setInspect(getActiveId(), true).catch(() => {});
  testerBrowser.a11y.onNodeHovered((node) => {
    if (!node || !node.nodeId) return;
    if (hoveredRow) hoveredRow.classList.remove('a11y-hovered');
    const row = nodeRowMap.get(node.nodeId);
    if (!row) return;
    hoveredRow = row;
    row.classList.add('a11y-hovered');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  testerBrowser.a11y.onNodeClicked(async (node) => {
    if (!node || !node.nodeId) return;
    if (selectNode(node.nodeId)) return;
    // Not in the currently rendered tree (e.g. page changed since the last
    // snapshot) — refresh and retry once before giving up.
    await loadA11yTree();
    if (!selectNode(node.nodeId)) {
      showInspectMessage("Selected element isn't in the accessibility tree");
    }
  });
}

let inspectMsgTimer = null;
function showInspectMessage(text) {
  const el = document.getElementById('a11yInspectMsg');
  if (!el) return;
  el.textContent = text;
  el.classList.add('visible');
  clearTimeout(inspectMsgTimer);
  inspectMsgTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

export function disableA11yHover() {
  inspecting = false;
  document.getElementById('a11yInspectBtn')?.classList.remove('on');
  if (!getActiveId()) return;
  testerBrowser.a11y.setInspect(getActiveId(), false).catch(() => {});
  testerBrowser.a11y.offNodeHovered();
  testerBrowser.a11y.offNodeClicked();
  if (hoveredRow) { hoveredRow.classList.remove('a11y-hovered'); hoveredRow = null; }
}

// Inspect (and hover-highlighting, which shares nodeRowMap) only work once a
// tree has actually been rendered — otherwise clicking a page element while
// inspecting is a silent no-op with no row to select.
function updateInspectAvailability() {
  const btn = document.getElementById('a11yInspectBtn');
  if (!btn) return;
  const available = nodeRowMap.size > 0;
  btn.disabled = !available;
  btn.title = available ? 'Pick an element on the page to select it in the tree' : 'Load the accessibility tree first';
  if (!available && inspecting) disableA11yHover();
}

function selectNode(nodeId) {
  const row = nodeRowMap.get(nodeId);
  if (!row) return false;
  if (selectedRow) selectedRow.classList.remove('a11y-selected');
  selectedRow = row;
  row.classList.add('a11y-selected');
  for (let li = row.closest('li.a11y-node')?.parentElement?.closest('li.a11y-node'); li; li = li.parentElement?.closest('li.a11y-node')) {
    const childList = li.querySelector(':scope > .a11y-children');
    const toggle = li.querySelector(':scope > .a11y-row > .a11y-toggle');
    if (childList && toggle && childList.style.display === 'none') {
      childList.style.display = '';
      toggle.textContent = '▾';
      if (li.dataset.nodeId) expandedIds.add(li.dataset.nodeId);
    }
  }
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return true;
}

export async function loadA11yTree() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  content.innerHTML = '<div class="a11y-loading">Loading accessibility tree…</div>';
  try {
    const nodes = await testerBrowser.a11y.getTree(getActiveId());
    if (!nodes || nodes.length === 0) {
      nodeRowMap.clear();
      content.innerHTML = '<div class="a11y-empty">No accessibility tree available for this page.</div>';
      return;
    }
    renderA11yTree(content, nodes);
  } catch (e) {
    nodeRowMap.clear();
    content.innerHTML = `<div class="a11y-empty">Error: ${e?.message ?? 'unknown'}</div>`;
  } finally {
    updateInspectAvailability();
  }
}

function renderA11yTree(panel, nodes) {
  nodeRowMap.clear();
  hoveredRow = null;
  selectedRow = null;
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
  li.dataset.nodeId = node.nodeId;

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

// ── Violations (axe-core audit) ─────────────────────────────────────────────

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

async function loadA11yViolations() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  content.innerHTML = '<div class="a11y-loading">Running accessibility audit…</div>';
  try {
    const violations = await testerBrowser.a11y.getViolations(getActiveId());
    renderA11yViolations(content, violations ?? []);
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty">Error: ${e?.message ?? 'unknown'}</div>`;
  }
}

function renderA11yViolations(panel, violations) {
  if (!violations || violations.length === 0) {
    panel.innerHTML = '<div class="a11y-empty">No violations found.</div>';
    return;
  }
  const byImpact = new Map();
  for (const v of violations) {
    const impact = v.impact || 'minor';
    if (!byImpact.has(impact)) byImpact.set(impact, []);
    byImpact.get(impact).push(v);
  }
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'a11y-violations';
  for (const impact of IMPACT_ORDER) {
    const group = byImpact.get(impact);
    if (!group || group.length === 0) continue;
    const section = document.createElement('div');
    section.className = `a11y-violation-group a11y-impact-${impact}`;
    const heading = document.createElement('h4');
    heading.className = 'a11y-violation-group-heading';
    heading.textContent = `${impact} (${group.length})`;
    section.appendChild(heading);
    for (const v of group) section.appendChild(buildViolationRow(v));
    wrap.appendChild(section);
  }
  panel.appendChild(wrap);
}

function buildViolationRow(violation) {
  const row = document.createElement('div');
  row.className = 'a11y-violation-row';

  const header = document.createElement('div');
  header.className = 'a11y-violation-header';

  const idEl = document.createElement('span');
  idEl.className = 'a11y-violation-id';
  idEl.textContent = violation.id;
  header.appendChild(idEl);

  const nodeCount = violation.nodes?.length ?? 0;
  const countEl = document.createElement('span');
  countEl.className = 'a11y-violation-count';
  countEl.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'}`;
  header.appendChild(countEl);
  row.appendChild(header);

  const descEl = document.createElement('div');
  descEl.className = 'a11y-violation-desc';
  descEl.textContent = violation.description || '';
  row.appendChild(descEl);

  if (violation.helpUrl) {
    const linkEl = document.createElement('a');
    linkEl.className = 'a11y-violation-link';
    linkEl.href = violation.helpUrl;
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
    linkEl.textContent = 'Learn more';
    row.appendChild(linkEl);
  }

  if (violation.nodes && violation.nodes.length > 0) {
    const nodesList = document.createElement('ul');
    nodesList.className = 'a11y-violation-nodes';
    for (const node of violation.nodes) nodesList.appendChild(buildViolationNodeRow(node));
    row.appendChild(nodesList);
  }

  return row;
}

// axe's `target` is an array of CSS selectors: a single-element array is the
// ordinary single-frame case (clickable-to-highlight below); more than one
// element means a shadow-DOM host path, and a nested array means the target
// is inside an iframe — both listed for visibility but not clickable, since
// there's no single querySelector that resolves them from the top document.
function buildViolationNodeRow(node) {
  const li = document.createElement('li');
  li.className = 'a11y-violation-node';
  const target = node.target;
  const simpleSelector = Array.isArray(target) && target.length === 1 && typeof target[0] === 'string'
    ? target[0] : null;
  const displayText = Array.isArray(target)
    ? target.map(t => Array.isArray(t) ? t.join(' > ') : t).join(' » ')
    : String(target ?? '(unable to resolve target)');
  li.textContent = displayText;
  if (simpleSelector) {
    li.classList.add('a11y-violation-node-clickable');
    li.title = 'Click to highlight this element on the page';
    li.addEventListener('click', () => highlightA11yNode(simpleSelector));
  }
  return li;
}

function highlightA11yNode(selector) {
  const id = getActiveId();
  if (!id) return;
  testerBrowser.a11y.highlightElement(id, selector).catch(() => {});
}

// ── Contrast (WCAG color contrast checker) ──────────────────────────────────

async function loadA11yContrast() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  content.innerHTML = '<div class="a11y-loading">Checking color contrast…</div>';
  try {
    const issues = await testerBrowser.a11y.getContrastIssues(getActiveId());
    renderA11yContrast(content, issues ?? []);
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty">Error: ${e?.message ?? 'unknown'}</div>`;
  }
}

function renderA11yContrast(panel, issues) {
  const failures = issues.filter(i => i.status === 'aa-fail');
  const notes = issues.filter(i => i.status === 'aaa-note');
  const unknown = issues.filter(i => i.status === 'unknown-background');

  if (failures.length === 0 && notes.length === 0 && unknown.length === 0) {
    panel.innerHTML = '<div class="a11y-empty">No AA contrast failures found.</div>';
    return;
  }

  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'a11y-contrast-results';

  if (failures.length > 0) {
    wrap.appendChild(buildContrastSection('AA failures', failures, 'fail'));
  } else {
    const empty = document.createElement('div');
    empty.className = 'a11y-empty';
    empty.textContent = 'No AA contrast failures found.';
    wrap.appendChild(empty);
  }
  if (notes.length > 0) {
    wrap.appendChild(buildContrastSection('Passes AA, fails AAA', notes, 'note'));
  }
  if (unknown.length > 0) {
    wrap.appendChild(buildContrastSection('Unknown background — check manually', unknown, 'unknown'));
  }

  panel.appendChild(wrap);
}

function buildContrastSection(title, items, kind) {
  const section = document.createElement('div');
  section.className = `a11y-contrast-group a11y-contrast-${kind}`;
  const heading = document.createElement('h4');
  heading.className = 'a11y-contrast-group-heading';
  heading.textContent = `${title} (${items.length})`;
  section.appendChild(heading);
  for (const item of items) section.appendChild(buildContrastRow(item, kind));
  return section;
}

function buildContrastRow(item, kind) {
  const row = document.createElement('div');
  row.className = 'a11y-contrast-row';
  row.title = 'Click to highlight this element on the page';
  row.addEventListener('click', () => highlightA11yNode(item.selector));

  const swatches = document.createElement('span');
  swatches.className = 'a11y-contrast-swatches';
  const fgSwatch = document.createElement('span');
  fgSwatch.className = 'a11y-contrast-swatch';
  fgSwatch.style.background = item.color;
  fgSwatch.title = `Text color: ${item.color}`;
  swatches.appendChild(fgSwatch);
  const bgSwatch = document.createElement('span');
  bgSwatch.className = 'a11y-contrast-swatch';
  bgSwatch.style.background = item.backgroundColor || 'transparent';
  bgSwatch.title = kind === 'unknown' ? 'Background image — no solid color' : `Background color: ${item.backgroundColor}`;
  swatches.appendChild(bgSwatch);
  row.appendChild(swatches);

  if (kind !== 'unknown') {
    const ratioEl = document.createElement('span');
    ratioEl.className = 'a11y-contrast-ratio';
    ratioEl.textContent = `${item.ratio.toFixed(1)}:1`;
    row.appendChild(ratioEl);

    const thresholdEl = document.createElement('span');
    thresholdEl.className = 'a11y-contrast-threshold';
    thresholdEl.textContent = `needs ${item.threshold}:1${item.isLarge ? ' (large text)' : ''}`;
    row.appendChild(thresholdEl);
  }

  const textEl = document.createElement('span');
  textEl.className = 'a11y-contrast-text';
  textEl.textContent = item.text || item.selector;
  row.appendChild(textEl);

  return row;
}
