import { ipcMain } from 'electron';
import { applySettingsPatch } from '../settingsPatch';
import type { AppDeps, ThemeStore } from './deps';
import type { JsonStore } from '../jsonFile';
import type { AppSettings } from '../settingsPatch';

export interface SettingsIpcStores {
  settingsStore: JsonStore<AppSettings>;
  themeStore: ThemeStore;
  // #259: called after a settings change, in case turning "install when idle"
  // on while an update is already sitting at 'downloaded' should start the
  // idle-check timer right away (the more common case — toggling it on
  // *before* an update ever arrives — is instead picked up by the
  // 'update-downloaded' autoUpdater handler's own call to this).
  maybeStartIdleInstallTimer: () => void;
}

/** App settings and chrome theme IPC. */
export function registerSettingsIpc(deps: AppDeps, stores: SettingsIpcStores): void {
  const { getSessionManager, rejectUntrustedSender } = deps;
  const { settingsStore, themeStore, maybeStartIdleInstallTimer } = stores;

  ipcMain.handle('settings:get', (e) => rejectUntrustedSender(e, 'settings:get') ? null : settingsStore.get());
  ipcMain.handle('settings:set', (e, patch: unknown) => {
    if (rejectUntrustedSender(e, 'settings:set')) return;
    const next = settingsStore.update(s => applySettingsPatch(s, patch));
    maybeStartIdleInstallTimer();
    return next;
  });

  ipcMain.handle('theme:get', (e) => rejectUntrustedSender(e, 'theme:get') ? undefined : themeStore.get().scheme);
  ipcMain.handle('theme:set', (e, scheme: string) => {
    if (rejectUntrustedSender(e, 'theme:set')) return;
    const value = scheme === 'light' ? 'light' : 'dark';
    themeStore.set({ scheme: value });
    getSessionManager()?.broadcastTheme(value);
  });
}
