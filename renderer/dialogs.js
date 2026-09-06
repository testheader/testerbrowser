/* global testerBrowser */
// Renders alert()/confirm()/prompt() calls from page content as a floating,
// non-blocking notification instead of letting Chromium show its default
// window-modal dialog (which would freeze the entire browser chrome, not
// just the calling tab — see preload/newtab.ts). Only the page that called
// the dialog stays blocked (it's waiting on the synchronous IPC reply);
// every other tab and the toolbar keep working normally.

export function initDialogs() {
  testerBrowser.dialogs.onShow(({ reqId, kind, message, defaultValue }) => {
    const notif = document.createElement('div');
    notif.className = 'dlg-notif';

    const msg = document.createElement('div');
    msg.className = 'dlg-msg';
    msg.textContent = message;
    notif.appendChild(msg);

    let input = null;
    if (kind === 'prompt') {
      input = document.createElement('input');
      input.className = 'dlg-input';
      input.value = defaultValue || '';
      notif.appendChild(input);
    }

    const respond = (result) => {
      testerBrowser.dialogs.respond(reqId, result);
      notif.remove();
    };

    const actions = document.createElement('div');
    actions.className = 'dlg-actions';

    if (kind === 'confirm' || kind === 'prompt') {
      const cancel = document.createElement('button');
      cancel.className = 'dlg-btn dlg-cancel';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => respond(kind === 'prompt' ? null : false);
      actions.appendChild(cancel);
    }

    const ok = document.createElement('button');
    ok.className = 'dlg-btn dlg-ok';
    ok.textContent = 'OK';
    ok.onclick = () => respond(kind === 'prompt' ? (input ? input.value : '') : kind === 'confirm' ? true : undefined);
    actions.appendChild(ok);

    notif.appendChild(actions);
    document.getElementById('dialogNotifications').appendChild(notif);
    if (input) input.focus();
  });
}
