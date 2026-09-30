// Globals the renderer (renderer/*.js) sees at runtime, for tsconfig.renderer.json.
// window.testerBrowser is exposed by src/preload/index.ts via contextBridge.
declare const testerBrowser: import('../src/preload/index').TesterBrowserApi;

interface Window {
  testerBrowser: import('../src/preload/index').TesterBrowserApi;
}

// querySelector()/querySelectorAll() return plain Element. Every element the
// renderer queries is an HTML or SVG element, both of which have dataset,
// focus()/blur() and style — declare that once here instead of a JSDoc cast at
// every querySelector call. Anything HTML-specific (value, disabled, checked,
// offsetWidth, …) still needs an explicit /** @type {HTMLInputElement} */ cast.
interface Element extends HTMLOrSVGElement, ElementCSSInlineStyle {}
