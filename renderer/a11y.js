/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { escHtml } from './utils.js';
import { setTabBadge } from './tab-badges.js';
import { renderEmptyState } from './empty-state.js';

const expandedIds = new Set();
const nodeRowMap = new Map(); // axNodeId → .a11y-row DOM element
let hoveredRow = null;
let selectedRow = null;
let inspecting = false;
let focusOverlayOn = false;
// #305: tree node lookup for the detail pane, and the last audit's violations
// (null = not run yet / the audit failed) feeding the issues chip and the
// pane's "Issues on this page" cards.
const treeNodes = new Map();
let lastViolations = null;
let selectedNodeId = null;
let activeView = 'tree'; // 'tree' | 'violations' | 'contrast' | 'structure' | 'altlabels'

// One entry per view: its toolbar button id, empty-state message, whether
// it's been manually refreshed at least once (gates reloadA11yIfLoaded the
// same way the original single-view Tree panel did), and its loader.
const VIEWS = {
  tree:       { btnId: 'a11yViewTreeBtn',       title: 'Accessibility tree', emptyMsg: 'Load the accessibility tree for this page.', loadLabel: 'Load tree',
                loaded: false, load: () => loadA11yTree() },
  violations: { btnId: 'a11yViewViolationsBtn', title: 'Violations audit', emptyMsg: 'Run an accessibility violations audit on this page.', loadLabel: 'Run audit',
                loaded: false, load: () => loadA11yViolations() },
  contrast:   { btnId: 'a11yViewContrastBtn',   title: 'Colour contrast', emptyMsg: 'Check this page for colour contrast failures.', loadLabel: 'Check contrast',
                loaded: false, load: () => loadA11yContrast() },
  structure:  { btnId: 'a11yViewStructureBtn',  title: 'Page structure', emptyMsg: 'List the headings and landmarks on this page.', loadLabel: 'Load structure',
                loaded: false, load: () => loadA11yStructure() },
  altlabels:  { btnId: 'a11yViewAltLabelsBtn',  title: 'Alt text and labels', emptyMsg: 'Check image alt text and form labels on this page.', loadLabel: 'Check alt text and labels',
                loaded: false, load: () => loadA11yAltLabels() },
  // #342: Focus is a view of its own; focus order (the default, and what Refresh runs)
  // and focus trap are the two functions inside it.
  focus:      { btnId: 'a11yViewFocusBtn',      title: 'Keyboard focus', emptyMsg: 'Show the keyboard tab order, or check the page for focus traps.', loadLabel: 'Show tab order',
                loaded: false, load: () => enableA11yFocusOrder() },
};

// #303: the pre-load state of a view, built with the shared empty state.
function a11yEmptyState(view) {
  return renderEmptyState({
    icon: 'accessibility', tone: 'accent', title: VIEWS[view].title, text: VIEWS[view].emptyMsg,
    actionLabel: VIEWS[view].loadLabel, actionIcon: 'play', actionTooltip: VIEWS[view].loadLabel,
    onAction: () => document.getElementById('a11yRefreshBtn').click(),
  });
}

// #327: the toolbar control is "Load …" until the active view has loaded, "Refresh" after.
function syncRefreshLabel() {
  const btn = document.getElementById('a11yRefreshBtn');
  if (!btn) return;
  const label = VIEWS[activeView].loaded ? 'Refresh' : VIEWS[activeView].loadLabel;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

export function initA11y() {
  const panel = document.getElementById('a11yPanel');
  if (!panel || panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="a11y-toolbar a11y-toolbar-row1">
      <div class="a11y-view-toggle">
        <button class="a11y-btn on" id="a11yViewTreeBtn" data-view="tree">Tree</button>
        <button class="a11y-btn" id="a11yViewViolationsBtn" data-view="violations">Violations</button>
        <button class="a11y-btn" id="a11yViewContrastBtn" data-view="contrast">Contrast</button>
        <button class="a11y-btn" id="a11yViewStructureBtn" data-view="structure">Structure</button>
        <button class="a11y-btn" id="a11yViewAltLabelsBtn" data-view="altlabels">Alt &amp; Labels</button>
        <button class="a11y-btn" id="a11yViewFocusBtn" data-view="focus">Focus</button>
      </div>
      <span class="net-spacer"></span>
      <span class="a11y-nodecount" id="a11yNodeCount"></span>
      <button class="console-icon-btn" id="a11yRefreshBtn" title="Refresh" aria-label="Refresh"><i class="icon-refresh-cw" aria-hidden="true"></i></button>
    </div>
    <div class="a11y-toolbar a11y-toolbar-row2" id="a11yContextRow">
      <div class="a11y-ctx-group" data-ctx="tree">
        <button class="a11y-btn a11y-inspect-btn" id="a11yInspectBtn" disabled title="Load the accessibility tree first"><i class="icon-mouse-pointer-2" aria-hidden="true"></i>Inspect element</button>
        <div class="net-search a11y-search" id="a11ySearchWrap"><i class="icon-search" aria-hidden="true"></i><input id="a11ySearch" placeholder="Find role or name" aria-label="Find role or name" /></div>
        <button class="a11y-issues-chip" id="a11yIssuesChip" hidden title="Issues found by the accessibility audit"><i class="icon-triangle-alert" aria-hidden="true"></i><span id="a11yIssuesCount"></span></button>
      </div>
      <div class="a11y-ctx-group" data-ctx="focus" hidden>
        <button class="a11y-btn" id="a11yFocusOrderBtn" title="Show a numbered tab-order overlay on the page">Focus order</button>
        <button class="a11y-btn" id="a11yFocusTrapBtn" title="Check whether Tab/Shift+Tab can reach every part of the page">Focus trap</button>
      </div>
      <span id="a11yInspectMsg" class="a11y-inspect-msg"></span>
    </div>
    <div class="a11y-content" id="a11yContent"></div>`;
  document.getElementById('a11yContent').replaceChildren(a11yEmptyState('tree'));
  document.getElementById('a11yRefreshBtn').addEventListener('click', () => {
    VIEWS[activeView].loaded = true;
    syncRefreshLabel();
    VIEWS[activeView].load();
  });
  syncRefreshLabel();
  /** @type {HTMLButtonElement} */ (document.getElementById('a11yInspectBtn')).addEventListener('click', () => {
    if (inspecting) disableA11yHover(); else enableA11yHover();
  });
  document.getElementById('a11yFocusOrderBtn').addEventListener('click', () => {
    if (focusOverlayOn) {
      disableA11yFocusOrder();
      // Restore whatever the currently active view would show on its own.
      const content = document.getElementById('a11yContent');
      if (content) content.replaceChildren(a11yEmptyState(activeView));
      if (VIEWS[activeView].loaded && activeView !== 'focus') VIEWS[activeView].load();
    } else {
      VIEWS.focus.loaded = true;
      enableA11yFocusOrder();
    }
  });
  document.getElementById('a11yFocusTrapBtn').addEventListener('click', () => runA11yFocusTrapCheck());
  document.getElementById('a11ySearch').addEventListener('input', applyTreeSearch);
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
  // #348: row 2 carries only the controls of the active view; views with none hide it.
  document.querySelectorAll('#a11yContextRow .a11y-ctx-group').forEach((el) => {
    /** @type {HTMLElement} */ (el).hidden = /** @type {HTMLElement} */ (el).dataset.ctx !== view;
  });
  document.getElementById('a11yContextRow').hidden = view !== 'tree' && view !== 'focus';
  if (view !== 'tree') document.getElementById('a11yNodeCount').textContent = '';
  if (view !== 'tree' && inspecting) disableA11yHover();
  // The focus overlay renders its list into the shared content area, same
  // as any view's Refresh — switching views would otherwise leave stale
  // badges on the page while showing the new view's (unrelated) content.
  if (focusOverlayOn) disableA11yFocusOrder();
  const content = document.getElementById('a11yContent');
  if (content) content.replaceChildren(a11yEmptyState(view));
  syncRefreshLabel();
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
  /** @type {HTMLButtonElement} */ (document.getElementById('a11yInspectBtn'))?.classList.add('on');
  testerBrowser.a11y.setInspect(getActiveId(), true).catch(() => {});
  testerBrowser.a11y.onNodeHovered((/** @type {any} */ node) => {
    if (!node || !node.nodeId) return;
    if (hoveredRow) hoveredRow.classList.remove('a11y-hovered');
    const row = nodeRowMap.get(node.nodeId);
    if (!row) return;
    hoveredRow = row;
    row.classList.add('a11y-hovered');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  testerBrowser.a11y.onNodeClicked(async (/** @type {any} */ node) => {
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
  /** @type {HTMLButtonElement} */ (document.getElementById('a11yInspectBtn'))?.classList.remove('on');
  if (!getActiveId()) return;
  testerBrowser.a11y.setInspect(getActiveId(), false).catch(() => {});
  testerBrowser.a11y.offNodeHovered();
  testerBrowser.a11y.offNodeClicked();
  if (hoveredRow) { hoveredRow.classList.remove('a11y-hovered'); hoveredRow = null; }
}

async function enableA11yFocusOrder() {
  const id = getActiveId();
  if (!id) return;
  focusOverlayOn = true;
  document.getElementById('a11yFocusOrderBtn')?.classList.add('on');
  const content = document.getElementById('a11yContent');
  if (content) content.innerHTML = '<div class="a11y-loading">Computing tab order…</div>';
  try {
    const items = await testerBrowser.a11y.setFocusOverlay(id, true);
    if (content) renderA11yFocusOrder(content, items ?? []);
  } catch (e) {
    if (content) content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
  }
}

// Mirrors disableA11yHover's cleanup: resets the toggle, tells the backend
// to remove the on-page badges, and stops there — the caller decides what
// the content area shows next (either the active view's own state, on an
// explicit toggle-off, or nothing further when it's mid-view-switch).
export function disableA11yFocusOrder() {
  focusOverlayOn = false;
  document.getElementById('a11yFocusOrderBtn')?.classList.remove('on');
  const id = getActiveId();
  if (id) testerBrowser.a11y.setFocusOverlay(id, false).catch(() => {});
}

function renderA11yFocusOrder(panel, items) {
  if (!items || items.length === 0) {
    panel.innerHTML = '<div class="a11y-empty">No focusable elements found on this page.</div>';
    return;
  }
  panel.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'a11y-structure-list';
  for (const item of items) list.appendChild(buildFocusOrderRow(item));
  panel.appendChild(list);
}

function buildFocusOrderRow(item) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row a11y-structure-row-clickable';
  li.title = 'Click to highlight this element on the page';
  li.addEventListener('click', () => highlightA11yNode(item.selector));

  const orderEl = document.createElement('span');
  orderEl.className = 'a11y-structure-role';
  orderEl.textContent = String(item.order);
  li.appendChild(orderEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'a11y-structure-name';
  nameEl.textContent = item.text || item.selector;
  li.appendChild(nameEl);

  if (item.tabindex > 0) {
    const tabindexEl = document.createElement('span');
    tabindexEl.className = 'a11y-altlabels-hint';
    tabindexEl.textContent = `tabindex=${item.tabindex}`;
    li.appendChild(tabindexEl);
  }

  if (item.noVisibleIndicator) {
    const flagEl = document.createElement('span');
    flagEl.className = 'a11y-structure-flag-badge';
    flagEl.textContent = 'no visible focus indicator';
    li.appendChild(flagEl);
  }

  return li;
}

// Inspect (and hover-highlighting, which shares nodeRowMap) only work once a
// tree has actually been rendered — otherwise clicking a page element while
// inspecting is a silent no-op with no row to select.
function updateInspectAvailability() {
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('a11yInspectBtn'));
  if (!btn) return;
  const available = nodeRowMap.size > 0;
  btn.disabled = !available;
  btn.title = available ? 'Pick an element on the page to select it in the tree' : 'Load the accessibility tree first';
  if (!available && inspecting) disableA11yHover();
}

// ── Detail pane (#305) ──

// "Name from" — where the accessible name came from, per CDP's name sources.
function nameSourceLabel(node) {
  const src = node.name?.sources?.find((s) => !s.superseded && s.value && s.type);
  return src ? src.type : '—';
}

function propRow(label, value, mono) {
  const row = document.createElement('div');
  row.className = 'a11y-prop';
  const k = document.createElement('span');
  k.className = 'a11y-prop-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'a11y-prop-val' + (mono ? ' mono' : '');
  v.textContent = String(value);
  row.append(k, v);
  return row;
}

function showNodeDetail(nodeId) {
  const pane = document.getElementById('a11yDetail');
  if (!pane) return;
  selectedNodeId = nodeId;
  pane.replaceChildren();
  const node = nodeId ? treeNodes.get(nodeId) : null;
  if (node) {
    const title = document.createElement('div');
    title.className = 'a11y-detail-title';
    const role = document.createElement('span');
    role.className = 'a11y-role';
    role.textContent = node.role?.value ?? 'unknown';
    title.appendChild(role);
    if (node.name?.value) title.appendChild(document.createTextNode(` ${node.name.value}`));
    pane.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'a11y-props';
    const level = getAxPropertyValue(node, 'level');
    grid.append(
      propRow('Name from', nameSourceLabel(node)),
      propRow('Level', level ?? '—'),
      propRow('Focusable', getAxPropertyValue(node, 'focusable') ?? false, true),
      propRow('Hidden', getAxPropertyValue(node, 'hidden') ?? node.ignored ?? false, true),
    );
    pane.appendChild(grid);
  } else {
    const hint = document.createElement('div');
    hint.className = 'a11y-detail-hint';
    hint.textContent = 'Select a node to see its properties.';
    pane.appendChild(hint);
  }
  pane.appendChild(buildIssueCards());
}

function buildIssueCards() {
  const wrap = document.createElement('div');
  wrap.className = 'a11y-issues';
  const h = document.createElement('div');
  h.className = 'a11y-issues-title';
  h.textContent = 'Issues on this page';
  wrap.appendChild(h);
  if (lastViolations === null) {
    const note = document.createElement('div');
    note.className = 'a11y-detail-hint';
    note.textContent = 'The accessibility audit has not produced results yet.';
    wrap.appendChild(note);
    return wrap;
  }
  if (lastViolations.length === 0) {
    const note = document.createElement('div');
    note.className = 'a11y-detail-hint';
    note.textContent = 'No issues found on this page.';
    wrap.appendChild(note);
    return wrap;
  }
  for (const v of lastViolations) {
    const selector = v.nodes?.[0]?.target?.[0];
    const card = document.createElement('div');
    card.className = 'a11y-issue-card' + (selector ? ' a11y-issue-card-clickable' : '');
    const icon = document.createElement('i');
    icon.className = 'icon-triangle-alert';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'a11y-issue-body';
    const t = document.createElement('div');
    t.className = 'a11y-issue-title';
    t.textContent = v.help || v.description || v.id;
    body.appendChild(t);
    if (selector) {
      const s = document.createElement('div');
      s.className = 'a11y-issue-selector';
      s.textContent = String(selector);
      body.appendChild(s);
      card.addEventListener('click', () => highlightA11yNode(String(selector)));
    }
    const impact = document.createElement('span');
    impact.className = 'a11y-issue-impact';
    impact.textContent = v.impact ? v.impact.charAt(0).toUpperCase() + v.impact.slice(1) : '';
    card.append(icon, body, impact);
    wrap.appendChild(card);
  }
  return wrap;
}

// Records the audit result (null = unavailable), then updates the toolbar's
// issues chip, the A11y tab badge and the open detail pane's issue cards.
function setIssues(violations) {
  lastViolations = violations;
  const chip = document.getElementById('a11yIssuesChip');
  const count = violations ? violations.length : 0;
  if (chip) {
    chip.hidden = count === 0;
    document.getElementById('a11yIssuesCount').textContent = `${count} issue${count === 1 ? '' : 's'}`;
  }
  setTabBadge('a11y', count);
  if (document.getElementById('a11yDetail')) showNodeDetail(selectedNodeId);
}

// Runs the existing axe audit in the background after a tree load.
async function refreshIssues(id) {
  try {
    const result = await testerBrowser.a11y.getViolations(id);
    if (getActiveId() !== id) return;
    if (result && result.ok === false) { setIssues(null); return; }
    setIssues(result?.violations ?? []);
  } catch {
    if (getActiveId() === id) setIssues(null);
  }
}

// Filters the tree by role/name: a node stays visible when it or any
// descendant matches, and matching branches are expanded.
function applyTreeSearch() {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('a11ySearch'));
  const root = document.querySelector('#a11yContent .a11y-tree');
  if (!input || !root) return;
  const q = input.value.trim().toLowerCase();
  const visit = (li) => {
    const own = !q || (li.dataset.search || '').includes(q);
    const childLis = [...li.querySelectorAll(':scope > .a11y-children > li.a11y-node')];
    let anyChild = false;
    for (const c of childLis) if (visit(c)) anyChild = true;
    const show = own || anyChild;
    li.hidden = !show;
    if (q && anyChild) {
      const list = li.querySelector(':scope > .a11y-children');
      if (list) list.style.display = '';
    }
    return show;
  };
  for (const li of root.querySelectorAll(':scope > li.a11y-node')) visit(li);
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
  showNodeDetail(nodeId);
  return true;
}

export async function loadA11yTree() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  setIssues(null); // the last audit belongs to whatever page was loaded before
  content.innerHTML = '<div class="a11y-loading">Loading accessibility tree…</div>';
  try {
    const nodes = await testerBrowser.a11y.getTree(getActiveId());
    if (!nodes || nodes.length === 0) {
      nodeRowMap.clear();
      content.innerHTML = '<div class="a11y-empty">No accessibility tree available for this page.</div>';
      return;
    }
    renderA11yTree(content, nodes);
    document.getElementById('a11yNodeCount').textContent = `${nodes.length} nodes · updated on navigation`;
    refreshIssues(getActiveId());
  } catch (e) {
    nodeRowMap.clear();
    content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
  } finally {
    updateInspectAvailability();
  }
}

function renderA11yTree(panel, nodes) {
  nodeRowMap.clear();
  treeNodes.clear();
  hoveredRow = null;
  selectedRow = null;
  selectedNodeId = null;
  const nodeMap = new Map();
  for (const n of nodes) { nodeMap.set(n.nodeId, n); treeNodes.set(n.nodeId, n); }
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  if (!root) {
    panel.innerHTML = '<div class="a11y-empty">Empty tree.</div>';
    return;
  }
  issueTags = computeIssueTags(nodes);
  panel.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'a11y-tree-layout';
  const treeWrap = document.createElement('div');
  treeWrap.className = 'a11y-tree-wrap';
  const ul = document.createElement('ul');
  ul.className = 'a11y-tree';
  ul.appendChild(buildNode(root, nodeMap));
  treeWrap.appendChild(ul);
  const detail = document.createElement('aside');
  detail.className = 'a11y-detail';
  detail.id = 'a11yDetail';
  detail.setAttribute('aria-label', 'Selected node');
  layout.append(treeWrap, detail);
  panel.appendChild(layout);
  showNodeDetail(null);
  applyTreeSearch();
}

// ── Issue tags on tree rows (derived from the tree itself) ──
let issueTags = new Map(); // nodeId -> string[]

const NAME_REQUIRED_ROLES = new Set([
  'image', 'img', 'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'switch', 'slider', 'spinbutton',
]);

// "No name" for an interactive/image node with no accessible name, and
// "Level skips" for a heading whose level jumps by more than one.
export function computeIssueTags(nodes) {
  const tags = new Map();
  const add = (id, tag) => { if (!tags.has(id)) tags.set(id, []); tags.get(id).push(tag); };
  for (const n of nodes) {
    const role = n.role?.value;
    if (!n.ignored && NAME_REQUIRED_ROLES.has(role) && !(n.name?.value || '').trim()) add(n.nodeId, 'No name');
  }
  const ordered = flattenAxTree(nodes);
  const headingNodeByBackendId = new Map();
  for (const n of ordered) if (n.role?.value === 'heading') headingNodeByBackendId.set(n.backendDOMNodeId, n);
  for (const skip of findHeadingSkips(extractHeadings(ordered))) {
    const node = headingNodeByBackendId.get(skip.heading.backendDOMNodeId);
    if (node) add(node.nodeId, 'Level skips');
  }
  return tags;
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

  for (const tag of issueTags.get(node.nodeId) || []) {
    const tagEl = document.createElement('span');
    tagEl.className = 'a11y-issue-tag';
    tagEl.textContent = tag;
    row.appendChild(tagEl);
  }

  li.dataset.search = `${node.role?.value ?? ''} ${name ?? ''}`.toLowerCase();
  row.addEventListener('click', (ev) => {
    if (/** @type {HTMLElement} */ (ev.target).closest('.a11y-toggle')) return;
    selectNode(node.nodeId);
  });
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
    const result = await testerBrowser.a11y.getViolations(getActiveId());
    if (result && result.ok === false) {
      // A failed audit (CSP blocking eval, a page exception, a missing
      // vendored axe bundle, a detached debugger) must never render as the
      // same "No violations found" state a real, clean pass gets — see #222.
      content.innerHTML = `<div class="a11y-empty a11y-error">Accessibility audit failed: ${escHtml(result.error ?? 'unknown')}</div>`;
      return;
    }
    renderA11yViolations(content, result?.violations ?? []);
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty a11y-error">Accessibility audit failed: ${escHtml(e?.message ?? 'unknown')}</div>`;
  }
}

function renderA11yViolations(panel, violations) {
  setIssues(violations ?? []);
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
    content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
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

// ── Structure (heading & landmark outline) ──────────────────────────────────
// Pure, DOM-free helpers — exported for unit testing (see
// src/__tests__/a11y-structure.test.ts) — that turn the raw CDP AX node array
// (order not guaranteed to match the document) into a flat, document-order
// list, then pick out headings/landmarks and flag structural issues.

const LANDMARK_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search',
]);

export function flattenAxTree(nodes) {
  if (!nodes || nodes.length === 0) return [];
  const nodeMap = new Map();
  for (const n of nodes) nodeMap.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const ordered = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    ordered.push(node);
    for (const childId of node.childIds || []) walk(nodeMap.get(childId));
  })(root);
  return ordered;
}

function getAxPropertyValue(node, name) {
  const prop = node.properties?.find(p => p.name === name);
  return prop?.value?.value;
}

export function extractHeadings(orderedNodes) {
  return orderedNodes
    .filter(n => n.role?.value === 'heading')
    .map(n => ({
      backendDOMNodeId: n.backendDOMNodeId,
      level: Number(getAxPropertyValue(n, 'level')) || null,
      name: n.name?.value || '',
    }));
}

export function extractLandmarks(orderedNodes) {
  return orderedNodes
    .filter(n => LANDMARK_ROLES.has(n.role?.value))
    .map(n => ({
      backendDOMNodeId: n.backendDOMNodeId,
      role: n.role.value,
      name: n.name?.value || '',
    }));
}

// Flags a heading whose level jumps by more than 1 from the previous heading
// in the sequence (e.g. h2 straight to h4) — the first heading is never
// flagged regardless of its own level, and a heading with no resolvable
// level never updates what "previous" means for the next one.
export function findHeadingSkips(headings) {
  const skips = [];
  let prevLevel = null;
  for (const h of headings) {
    if (prevLevel !== null && typeof h.level === 'number' && h.level - prevLevel > 1) {
      skips.push({ heading: h, fromLevel: prevLevel, toLevel: h.level });
    }
    if (typeof h.level === 'number') prevLevel = h.level;
  }
  return skips;
}

export function hasMainLandmark(landmarks) {
  return landmarks.some(l => l.role === 'main');
}

async function loadA11yStructure() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  content.innerHTML = '<div class="a11y-loading">Loading document structure…</div>';
  try {
    const nodes = await testerBrowser.a11y.getTree(getActiveId());
    if (!nodes || nodes.length === 0) {
      content.innerHTML = '<div class="a11y-empty">No accessibility tree available for this page.</div>';
      return;
    }
    const ordered = flattenAxTree(nodes);
    renderA11yStructure(content, extractHeadings(ordered), extractLandmarks(ordered));
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
  }
}

function renderA11yStructure(panel, headings, landmarks) {
  const skips = findHeadingSkips(headings);
  const skippedNodeIds = new Set(skips.map(s => s.heading.backendDOMNodeId));
  const mainMissing = !hasMainLandmark(landmarks);

  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'a11y-structure';

  const headingSection = document.createElement('div');
  headingSection.className = 'a11y-structure-section';
  headingSection.appendChild(sectionHeading('Headings'));
  if (headings.length === 0) {
    headingSection.appendChild(emptyNote('No headings found.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'a11y-structure-list';
    for (const h of headings) {
      const skip = skippedNodeIds.has(h.backendDOMNodeId)
        ? skips.find(s => s.heading.backendDOMNodeId === h.backendDOMNodeId)
        : null;
      list.appendChild(buildHeadingRow(h, skip));
    }
    headingSection.appendChild(list);
  }
  wrap.appendChild(headingSection);

  const landmarkSection = document.createElement('div');
  landmarkSection.className = 'a11y-structure-section';
  landmarkSection.appendChild(sectionHeading('Landmarks'));
  if (mainMissing) {
    landmarkSection.appendChild(flagNote('No <main> landmark found on this page.'));
  }
  if (landmarks.length === 0) {
    landmarkSection.appendChild(emptyNote('No landmarks found.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'a11y-structure-list';
    for (const l of landmarks) list.appendChild(buildLandmarkRow(l));
    landmarkSection.appendChild(list);
  }
  wrap.appendChild(landmarkSection);

  panel.appendChild(wrap);
}

function sectionHeading(text) {
  const h = document.createElement('h4');
  h.className = 'a11y-structure-section-heading';
  h.textContent = text;
  return h;
}

function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'a11y-empty';
  el.textContent = text;
  return el;
}

function flagNote(text) {
  const el = document.createElement('div');
  el.className = 'a11y-structure-flag';
  el.textContent = text;
  return el;
}

function buildHeadingRow(h, skip) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row' + (skip ? ' a11y-structure-row-flagged' : '');
  attachHighlightHandler(li, h.backendDOMNodeId);

  const levelEl = document.createElement('span');
  levelEl.className = 'a11y-structure-level';
  levelEl.textContent = h.level ? `H${h.level}` : 'H?';
  li.appendChild(levelEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'a11y-structure-name';
  nameEl.textContent = h.name || '(no accessible name)';
  li.appendChild(nameEl);

  if (skip) {
    const flagEl = document.createElement('span');
    flagEl.className = 'a11y-structure-flag-badge';
    flagEl.textContent = `skipped level — jumped from H${skip.fromLevel} to H${skip.toLevel}`;
    li.appendChild(flagEl);
  }

  return li;
}

function buildLandmarkRow(l) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row';
  attachHighlightHandler(li, l.backendDOMNodeId);

  const roleEl = document.createElement('span');
  roleEl.className = 'a11y-structure-role';
  roleEl.textContent = l.role;
  li.appendChild(roleEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'a11y-structure-name';
  nameEl.textContent = l.name || '(no accessible name)';
  li.appendChild(nameEl);

  return li;
}

function attachHighlightHandler(row, backendDOMNodeId) {
  if (typeof backendDOMNodeId !== 'number') return;
  row.classList.add('a11y-structure-row-clickable');
  row.title = 'Click to highlight this element on the page';
  row.addEventListener('click', () => {
    const id = getActiveId();
    if (!id) return;
    testerBrowser.a11y.highlightNode(id, backendDOMNodeId).catch(() => {});
  });
}

// ── Alt & Labels (image alt-text & form label audit) ────────────────────────

async function loadA11yAltLabels() {
  const content = document.getElementById('a11yContent');
  if (!content) return;
  if (!getActiveId()) {
    content.innerHTML = '<div class="a11y-empty">No active session.</div>';
    return;
  }
  content.innerHTML = '<div class="a11y-loading">Checking image alt text and form labels…</div>';
  try {
    const issues = await testerBrowser.a11y.getAltLabelIssues(getActiveId());
    renderA11yAltLabels(content, issues ?? { images: [], fields: [] });
  } catch (e) {
    content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
  }
}

function renderA11yAltLabels(panel, issues) {
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'a11y-altlabels';

  const imgSection = document.createElement('div');
  imgSection.className = 'a11y-structure-section';
  imgSection.appendChild(sectionHeading('Images missing alt text'));
  if (issues.images.length === 0) {
    imgSection.appendChild(emptyNote('No images missing alt text found.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'a11y-structure-list';
    for (const img of issues.images) list.appendChild(buildAltIssueRow(img));
    imgSection.appendChild(list);
  }
  wrap.appendChild(imgSection);

  const fieldSection = document.createElement('div');
  fieldSection.className = 'a11y-structure-section';
  fieldSection.appendChild(sectionHeading('Unlabeled form fields'));
  if (issues.fields.length === 0) {
    fieldSection.appendChild(emptyNote('No unlabeled form fields found.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'a11y-structure-list';
    for (const field of issues.fields) list.appendChild(buildLabelIssueRow(field));
    fieldSection.appendChild(list);
  }
  wrap.appendChild(fieldSection);

  panel.appendChild(wrap);
}

function buildAltIssueRow(img) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row a11y-structure-row-clickable';
  li.title = 'Click to highlight this element on the page';
  li.addEventListener('click', () => highlightA11yNode(img.selector));

  const roleEl = document.createElement('span');
  roleEl.className = 'a11y-structure-role';
  roleEl.textContent = 'img';
  li.appendChild(roleEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'a11y-structure-name';
  nameEl.textContent = img.src || img.selector;
  li.appendChild(nameEl);

  if (img.likelyDecorative) {
    const hintEl = document.createElement('span');
    hintEl.className = 'a11y-altlabels-hint';
    hintEl.textContent = 'likely decorative';
    hintEl.title = 'Heuristic only (role="presentation"/"none" or a tiny image) — not a guarantee';
    li.appendChild(hintEl);
  }

  return li;
}

function buildLabelIssueRow(field) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row a11y-structure-row-clickable';
  li.title = 'Click to highlight this element on the page';
  li.addEventListener('click', () => highlightA11yNode(field.selector));

  const roleEl = document.createElement('span');
  roleEl.className = 'a11y-structure-role';
  roleEl.textContent = field.type;
  li.appendChild(roleEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'a11y-structure-name';
  nameEl.textContent = field.selector;
  li.appendChild(nameEl);

  return li;
}

// ── Focus trap detector ──────────────────────────────────────────────────
// A one-shot check, not a toggle like Focus order — it dispatches real Tab/
// Shift+Tab key presses (briefly moving the page's own focus around) and
// reports directly into the shared content area, the same way a view's
// Refresh does.

async function runA11yFocusTrapCheck() {
  const id = getActiveId();
  if (!id) return;
  const content = document.getElementById('a11yContent');
  if (content) content.innerHTML = '<div class="a11y-loading">Checking for focus traps (dispatching real Tab key presses)…</div>';
  try {
    const result = await testerBrowser.a11y.detectFocusTrap(id);
    if (content) renderA11yFocusTrap(content, result);
  } catch (e) {
    if (content) content.innerHTML = `<div class="a11y-empty">Error: ${escHtml(e?.message ?? 'unknown')}</div>`;
  }
}

function renderA11yFocusTrap(panel, result) {
  if (!result) {
    panel.innerHTML = '<div class="a11y-empty">Could not run the focus trap check for this page.</div>';
    return;
  }
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'a11y-structure';
  wrap.appendChild(buildFocusTrapSection('Forward (Tab)', result.forward));
  wrap.appendChild(buildFocusTrapSection('Backward (Shift+Tab)', result.backward));
  panel.appendChild(wrap);
}

function buildFocusTrapSection(title, direction) {
  const section = document.createElement('div');
  section.className = 'a11y-structure-section';
  section.appendChild(sectionHeading(title));
  if (direction.passed) {
    section.appendChild(emptyNote('No focus trap detected.'));
    return section;
  }
  section.appendChild(flagNote(focusTrapMessage(direction)));
  if (direction.trappedElements.length > 0) {
    const list = document.createElement('ul');
    list.className = 'a11y-structure-list';
    for (const selector of direction.trappedElements) list.appendChild(buildFocusTrapElementRow(selector));
    section.appendChild(list);
  }
  return section;
}

function buildFocusTrapElementRow(selector) {
  const li = document.createElement('li');
  li.className = 'a11y-structure-row a11y-structure-row-clickable';
  li.title = 'Click to highlight this element on the page';
  li.textContent = selector;
  li.addEventListener('click', () => highlightA11yNode(selector));
  return li;
}

function focusTrapMessage(direction) {
  if (direction.kind === 'cycle') {
    return `Focus trap: cycles among ${direction.trappedElements.length} elements without ever reaching the rest of the page.`;
  }
  if (direction.kind === 'dead-end') {
    return 'Focus trap: focus stopped advancing partway through the page (dead end).';
  }
  return "Focus trap check didn't complete — couldn't confirm the walk reached the end of the page.";
}
