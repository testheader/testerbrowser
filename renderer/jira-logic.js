// Pure helpers behind the Jira ticket view (#314) — kept free of DOM access
// so they are unit-testable in jest's node environment.

/**
 * Flattens an Atlassian Document Format node (or plain string) to text.
 * @param {any} node
 * @returns {string}
 */
export function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) return node.content.map(adfText).join(node.type === 'doc' ? '\n' : ' ').trim();
  return '';
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * The checklist under an "Acceptance criteria" heading (or bold paragraph) in
 * a ticket description: every list item between that heading and the next
 * heading. Returns [] when the ticket has no such section.
 * @param {any} adf
 * @returns {string[]}
 */
export function extractAcceptanceCriteria(adf) {
  const nodes = adf && Array.isArray(adf.content) ? adf.content : [];
  const items = [];
  let inSection = false;
  for (const n of nodes) {
    const text = adfText(n).trim();
    if (n.type === 'heading' || (n.type === 'paragraph' && /^acceptance criteria:?$/i.test(text))) {
      inSection = /acceptance criteria/i.test(text);
      continue;
    }
    if (!inSection) continue;
    if (LIST_TYPES.has(n.type) && Array.isArray(n.content)) {
      for (const li of n.content) {
        const t = adfText(li).trim();
        if (t) items.push(t);
      }
    }
  }
  return items;
}

/**
 * Host part of the configured Jira base URL, for the connection indicator.
 * @param {string} baseUrl
 * @returns {string}
 */
export function jiraHost(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return ''; }
}
