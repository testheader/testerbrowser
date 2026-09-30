import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { SessionManager } from '../sessionManager';
import type { VisualRegressionStore } from '../visualRegressionStore';
import type { DebugLogStore } from '../debugLogStore';
import type { JsonStore } from '../jsonFile';
import type { AppLog } from '../appLogger';

/**
 * Shared dependency bundle every `ipc/<feature>.ts` module's `register()`
 * takes (#255/#283) — getters for state that's reassigned after module load
 * (`win`/`sessionManager`/`visualRegressionStore` are only constructed once
 * `app.whenReady()`'s `createWindow()` runs, well after these IPC handlers
 * are registered, so a plain captured reference at import time would stay
 * null forever), plus the handful of index.ts-owned helpers/stores enough
 * of the split modules need that threading them through individually would
 * just be the same list copied N times. Feature-specific dependencies
 * (a store or helper only one module uses) are still passed as that
 * module's own extra `register()` argument rather than stuffed in here.
 */
// available-manual (#230): a newer release exists (found by the error
// handler's release-scan fallback in index.ts) but electron-updater has no
// update info to actually download it with.
export type UpdateStatus = 'checking' | 'available' | 'available-manual' | 'downloading' | 'downloaded' | 'not-available' | 'error';

export interface AppDeps {
  getWin: () => BrowserWindow | null;
  getSessionManager: () => SessionManager | null;
  getVisualRegressionStore: () => VisualRegressionStore | null;
  getDebugLogStore: () => DebugLogStore | null;
  getLogsDir: () => string;
  log: AppLog;
  recordAppError: (message: string) => void;
  persistSessionUrls: () => void;
  // #217: only the chrome window itself or a frame actually showing the
  // new-tab page may call a handful of app-wide-state channels (settings,
  // bookmarks, theme, speed dial) — see index.ts's own isTrustedIpcSender
  // for why. Returns true (and logs once) when the call should be rejected.
  rejectUntrustedSender: (e: IpcMainInvokeEvent, channel: string) => boolean;
}

export interface Bookmark { url: string; title: string; addedAt: number; folderId: string | null; }
export interface BookmarkFolder { id: string; name: string; createdAt: number; }
export interface SpeedDialTile { id: string; url: string; title: string; }
export interface SavedTest { id: string; name: string; steps: object[]; createdAt: number; updatedAt: number; }

export type BookmarkStore = JsonStore<Bookmark[]>;
export type BookmarkFoldersStore = JsonStore<BookmarkFolder[]>;
export type UrlHistoryStore = JsonStore<string[]>;
export type SpeedDialStore = JsonStore<SpeedDialTile[]>;
export type ThemeStore = JsonStore<{ scheme: string }>;
export type TestsStore = JsonStore<SavedTest[]>;
