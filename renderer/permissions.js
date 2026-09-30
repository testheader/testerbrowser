/* global testerBrowser */
import { setPermissionBarHeight } from './layout.js';

const PERM_LABELS = {
  geolocation:       'access your location',
  notifications:     'show notifications',
  camera:            'access your camera',
  microphone:        'access your microphone',
  media:             'access your camera and microphone',
  midi:              'access MIDI devices',
  'clipboard-read':  'read the clipboard',
  'clipboard-write': 'write to the clipboard',
};

export function initPermissions() {
  testerBrowser.permission.onRequest(async ({ reqId, permission, origin, sessionId, externalUrl }) => {
    const notif = document.createElement('div');
    notif.className = 'perm-notif';
    notif.dataset.reqId = reqId;

    // #276: names which tab the prompt belongs to — with several tabs open,
    // a tester previously had no way to tell which page was asking.
    // sessionId can be null (the requesting webContents wasn't matched to a
    // live tab, e.g. it's already closing), in which case the tab context
    // is silently omitted rather than shown as broken.
    const session = sessionId ? (await testerBrowser.sessions.list().catch(() => [])).find(s => s.id === sessionId) : null;
    // A closed-in-the-meantime tab (dismissed via permission:dismiss below,
    // usually before this async lookup even resolves) must not still render.
    if (!document.getElementById('permissionNotifications')) return;

    if (session) {
      const dot = document.createElement('span');
      dot.className = 'perm-tab-dot';
      dot.style.backgroundColor = session.color || '#4fc3f7';
      notif.appendChild(dot);
      const tabLabel = document.createElement('span');
      tabLabel.className = 'perm-tab-label';
      tabLabel.textContent = session.name;
      notif.appendChild(tabLabel);
    }

    const msg = document.createElement('span');
    msg.className   = 'perm-msg';
    // An openExternal prompt names the exact URL being handed to the OS (and
    // is never remembered — see permissionManager.ts), truncated for display.
    msg.textContent = permission === 'openExternal' && externalUrl
      ? `${origin} wants to open ${externalUrl.length > 200 ? externalUrl.slice(0, 200) + '…' : externalUrl} in an external app`
      : `${origin} wants to ${PERM_LABELS[permission] || permission}`;
    if (externalUrl) msg.title = externalUrl;
    notif.appendChild(msg);

    const allow = document.createElement('button');
    allow.className   = 'perm-btn perm-allow';
    allow.textContent = 'Allow';
    allow.onclick = () => { testerBrowser.permission.respond(reqId, true);  notif.remove(); syncPermissionBarHeight(); };
    notif.appendChild(allow);

    const block = document.createElement('button');
    block.className   = 'perm-btn perm-block';
    block.textContent = 'Block';
    block.onclick = () => { testerBrowser.permission.respond(reqId, false); notif.remove(); syncPermissionBarHeight(); };
    notif.appendChild(block);

    document.getElementById('permissionNotifications').appendChild(notif);
    syncPermissionBarHeight();
  });

  // #276: the main process auto-dismisses a prompt that timed out, or whose
  // tab was closed while it was still pending — either way, this specific
  // notification (if it's even still showing) is stale and must go away
  // without the tester having to interact with it.
  testerBrowser.permission.onDismiss(({ reqId }) => {
    document.querySelector(`.perm-notif[data-req-id="${CSS.escape(reqId)}"]`)?.remove();
    syncPermissionBarHeight();
  });
}

function syncPermissionBarHeight() {
  const container = document.getElementById('permissionNotifications');
  if (!container) return;
  setPermissionBarHeight(container.children.length > 0 ? container.offsetHeight + 8 : 0);
}
