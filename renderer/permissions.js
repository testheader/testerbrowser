/* global testerBrowser */

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
  testerBrowser.permission.onRequest(({ reqId, permission, origin }) => {
    const notif = document.createElement('div');
    notif.className = 'perm-notif';

    const msg = document.createElement('span');
    msg.className   = 'perm-msg';
    msg.textContent = `${origin} wants to ${PERM_LABELS[permission] || permission}`;
    notif.appendChild(msg);

    const allow = document.createElement('button');
    allow.className   = 'perm-btn perm-allow';
    allow.textContent = 'Allow';
    allow.onclick = () => { testerBrowser.permission.respond(reqId, true);  notif.remove(); };
    notif.appendChild(allow);

    const block = document.createElement('button');
    block.className   = 'perm-btn perm-block';
    block.textContent = 'Block';
    block.onclick = () => { testerBrowser.permission.respond(reqId, false); notif.remove(); };
    notif.appendChild(block);

    document.getElementById('permissionNotifications').appendChild(notif);
  });
}
