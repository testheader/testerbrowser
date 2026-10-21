// webContents.loadURL() rejects with ERR_ABORTED (-3) when a navigation it
// started is superseded by another one — and when a view is still loading its
// initial new-tab page, Electron reports that abort on the *new* call, naming
// the old URL. Callers that navigate a fresh view straight away (clone,
// snapshot import) treat it as "the navigation was replaced", not a failure;
// they wait for the frame to load afterwards anyway.
export function isAbortedLoad(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_ABORTED|\(-3\)/.test(msg);
}

export async function loadUrlIgnoringAbort(wc: { loadURL(url: string): Promise<void> }, url: string): Promise<void> {
  try {
    await wc.loadURL(url);
  } catch (err) {
    if (!isAbortedLoad(err)) throw err;
  }
}
