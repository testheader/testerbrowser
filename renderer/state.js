/* Shared mutable state — one object, mutated in place, so all modules see updates. */

export const state = {
  activeId:           null,
  lastTs:             0,
  sessionCounter:     0,
  mruStack:           [],
  tabOrder:           [],
  tabClickTimer:      null,
  dragSourceId:       null,
  tabFavicons:        {},
  tabTitles:          {},
  navState:           {},
  tabLoading:         {},
  closedTabs:         [],      // [{ name, url, partition, color }] — most recent last
  timelineEvents:     [],      // ring buffer, max TIMELINE_MAX entries
  notesSessionId:     null,
  domainFilterActive: true,
  consoleHeight:      220,
  findOpen:           false,
  bookmarksBarVisible:false,
  autoScroll:         true,
  activeConsoleTab:   'console',
  consoleVisible:     true,
  bookmarks:          [],
  urlHistory:         [],
  detailTabs:         [],
  activeDetailTabId:  null,
};

export const TIMELINE_MAX    = 5000;
export const TIMELINE_DOM_MAX = 500;
export const TOPBAR_BASE     = 91;   // 40px tabs + 46px toolbar + 2px border + 3px loading bar
export const FIND_BAR_H      = 40;
export const BOOKMARKS_BAR_H = 32;
