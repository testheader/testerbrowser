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

/**
 * Human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The most recent `limit` comments of a ticket, oldest first, flattened to
 * plain text. Jira returns them oldest first already; `total` may exceed what
 * the issue payload carried, so `hidden` counts every older one.
 * @param {any} commentField  the issue's `fields.comment`
 * @param {number} [limit]
 * @returns {{ comments: { author: string, created: string, text: string }[], hidden: number }}
 */
export function recentComments(commentField, limit = 3) {
  const all = commentField && Array.isArray(commentField.comments) ? commentField.comments : [];
  const total = Math.max(Number(commentField?.total) || 0, all.length);
  const shown = all.slice(-limit).map((c) => ({
    author: c?.author?.displayName ?? 'Unknown',
    created: c?.created ?? '',
    text: adfText(c?.body),
  }));
  return { comments: shown, hidden: Math.max(0, total - shown.length) };
}

/**
 * A ticket's attachments, normalised for display.
 * @param {any} attachmentField  the issue's `fields.attachment`
 * @returns {{ filename: string, size: number, url: string }[]}
 */
export function attachmentList(attachmentField) {
  if (!Array.isArray(attachmentField)) return [];
  return attachmentField
    .filter((a) => a && a.filename)
    .map((a) => ({ filename: String(a.filename), size: Number(a.size) || 0, url: typeof a.content === 'string' ? a.content : '' }));
}
