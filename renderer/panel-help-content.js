// Help text for the "?" button in the console header — one entry per console
// tab, keyed by the tab name switchConsoleTab() uses. Plain data (no DOM) so a
// unit test can check every tab has an entry. Keep entries short: what the tab
// is for, how to use it, and the one gotcha a tester would trip over.
export const PANEL_HELP = {
  console: {
    title: 'Console',
    body: [
      'Everything the page logged or requested, recorded from the moment the tab was created — even while this panel was closed.',
      'Use the Req / Res / Err / JS / Log pills to filter by kind. Export the recording as a HAR file, or clear it, from the buttons on the right.',
    ],
  },
  network: {
    title: 'Network',
    body: [
      'The requests and responses recorded for the active tab. Select a row to open its details.',
      'The recording is a ring buffer: once it holds 20,000 events the oldest are dropped.',
    ],
  },
  storage: {
    title: 'Storage',
    body: [
      'Cookies, localStorage, sessionStorage, IndexedDB and remembered permissions for the active tab. Cookies and localStorage can be added, edited and deleted; the rest are read-only.',
      'The list is fetched when you refresh or switch tabs, and the filter searches that snapshot. Turn on Auto-refresh to keep it live while this tab is open.',
      'localStorage, sessionStorage and IndexedDB show whichever page is loaded right now.',
    ],
  },
  a11y: {
    title: 'Accessibility',
    body: [
      'Scan the loaded page for accessibility problems such as contrast and structure violations, and inspect keyboard focus order.',
      'Results describe the page as it is now — re-scan after the page changes.',
    ],
  },
  diff: {
    title: 'Network diff',
    body: [
      'Compare the requests two tabs made: pick two sessions, then Compare. Rows are grouped as changed, added, removed or unchanged.',
      'Ignored query params (such as cache-busters) are stripped before requests are matched — edit the chips to change that.',
      'Expand a row for header and body differences; copy either side as cURL.',
    ],
  },
  vr: {
    title: 'UI diff',
    body: [
      'Compare what a page looks like now against a baseline screenshot: 1) capture a baseline or pick a saved one, 2) choose which tab is the current page, 3) Compare.',
      'The result shows the % of pixels changed, a pass/fail against your "Pass if at most" limit, and each changed region — step through them with Prev/Next (or N / P). View them side by side, as an overlay with a slider, or as a diff of just the changed pixels; + / − / 0 zoom.',
      'Colour tolerance decides how different a pixel must be to count. Ignore regions (clocks, ads, animations) are left out of the % entirely; after changing either, Update result re-runs the compare on the same screenshots.',
      'Saved baselines can be renamed, exported and imported to share them.',
    ],
  },
  spoof: {
    title: 'Spoof',
    body: [
      'Make the active tab look like a different device, place or time: viewport, user agent, timezone, locale, geolocation, clock offset and colour scheme.',
      'Pick a preset or fill in fields, then Apply to tab. It only affects this tab; Reset all clears it.',
    ],
  },
  security: {
    title: 'Security',
    body: [
      "Connection and certificate details for the page, mixed-content requests, and checks on its security headers, cookie flags and CORS settings.",
      'Not available for pages without a network connection, such as the new-tab page or local files.',
    ],
  },
  mock: {
    title: 'Mock',
    body: [
      'Answer requests with your own response instead of hitting the server. Rules belong to the tab’s session.',
      'Rules are checked top to bottom and the first enabled match wins — reorder them to change priority. Export and import rules as JSON.',
    ],
  },
  resilience: {
    title: 'Resilience',
    body: [
      'See how the page behaves when things go wrong: throttle the network and CPU for this tab, or add rules that delay, abort or fail requests matching a URL pattern.',
      'Throttling is per tab; clear it to go back to normal.',
    ],
  },
  jira: {
    title: 'Jira',
    body: [
      'Look up tickets and create issues from what you captured while testing.',
      'Configure your Jira address, project and API token first. The address must be https, and the token is stored encrypted on this computer.',
    ],
  },
  tests: {
    title: 'Record Playback',
    body: [
      'Record your clicks and typing into steps, save them as a test, and play them back later.',
      'Saved tests can be exported and imported as JSON — only import test files you trust.',
    ],
  },
  follow: {
    title: 'Follow Along',
    body: [
      'Pick a leader and a follower tab, then Start: clicks and typing in the leader are repeated on the matching elements in the follower — handy for comparing two environments side by side.',
      'Turn on “Mirror navigation” to send the follower to the same pages as the leader; leave it off to mirror only in-page actions.',
    ],
  },
  debuglog: {
    title: 'Debug Log',
    body: [
      'TesterBrowser’s own internal log (not the page’s). Useful when reporting a bug about the app itself.',
    ],
  },
};
