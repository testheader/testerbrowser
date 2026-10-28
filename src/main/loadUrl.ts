// webContents.loadURL() rejects with ERR_ABORTED (-3) when a navigation it
// started is superseded by another one — and when a view is still loading its
// initial new-tab page, Electron reports that abort on the *new* call, naming
// the old URL. Callers that navigate a fresh view straight away (clone,
// snapshot import) treat it as "the navigation was replaced", not a failure.
export function isAbortedLoad(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_ABORTED|\(-3\)/.test(msg);
}

// Resolves true once the page has finished loading (loadURL() itself resolves
// on did-finish-load), or false when the call was aborted early — in which
// case the navigation is still in flight and the caller must wait for its
// load (waitForFrameLoad). Waiting after a load that already finished would
// only sit out waitForFrameLoad's timeout, since did-finish-load has fired.
export async function loadUrlIgnoringAbort(wc: { loadURL(url: string): Promise<void> }, url: string): Promise<boolean> {
  try {
    await wc.loadURL(url);
    return true;
  } catch (err) {
    if (!isAbortedLoad(err)) throw err;
    return false;
  }
}
