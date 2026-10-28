import { isAbortedLoad, loadUrlIgnoringAbort } from '../loadUrl';

describe('loadUrlIgnoringAbort', () => {
  it('swallows ERR_ABORTED (-3) rejections, reporting the load as still in flight', async () => {
    const wc = { loadURL: jest.fn().mockRejectedValue(new Error("ERR_ABORTED (-3) loading 'file:///x/newtab.html'")) };
    await expect(loadUrlIgnoringAbort(wc, 'http://a.test/')).resolves.toBe(false);
    expect(isAbortedLoad(new Error(' (-3) loading')) ).toBe(true);
  });

  it('rethrows any other load failure', async () => {
    const wc = { loadURL: jest.fn().mockRejectedValue(new Error('ERR_NAME_NOT_RESOLVED (-105) loading')) };
    await expect(loadUrlIgnoringAbort(wc, 'http://a.test/')).rejects.toThrow('-105');
  });

  it('resolves true on success, so callers know the page already loaded', async () => {
    const wc = { loadURL: jest.fn().mockResolvedValue(undefined) };
    await expect(loadUrlIgnoringAbort(wc, 'http://a.test/')).resolves.toBe(true);
    expect(wc.loadURL).toHaveBeenCalledWith('http://a.test/');
  });
});
