import type { SpeedDialTile } from './ipc/deps';

// Starter tiles for a fresh profile. renderer/newtab.js keeps a copy for when
// the preload is unavailable; speedDialDefaults.test.ts keeps them in sync and
// google-free (#340).
export const DEFAULT_SPEED_DIAL: SpeedDialTile[] = [
  { id: '1', url: 'https://duckduckgo.com',        title: 'DuckDuckGo' },
  { id: '2', url: 'https://github.com',            title: 'GitHub' },
  { id: '3', url: 'https://developer.mozilla.org', title: 'MDN' },
  { id: '4', url: 'https://stackoverflow.com',     title: 'Stack Overflow' },
  { id: '5', url: 'https://caniuse.com',           title: 'Can I Use' },
  { id: '6', url: 'https://regex101.com',          title: 'Regex 101' },
  { id: '7', url: 'https://jsonformatter.org',     title: 'JSON Formatter' },
  { id: '8', url: 'https://httpstatuses.io',       title: 'HTTP Status' },
];
