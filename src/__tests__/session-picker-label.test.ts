import { pickerLabel } from '../../renderer/session-picker.js';

describe('pickerLabel (#258 — disambiguating session pickers)', () => {
  it('appends the host of the session\'s current URL', () => {
    const session = { id: 'a', name: 'Tab 1', url: 'https://example.com/path', partition: 'a' };
    expect(pickerLabel(session, [session])).toBe('Tab 1 — example.com');
  });

  it('falls back to just the name when the URL is missing', () => {
    const session = { id: 'a', name: 'Tab 1', url: undefined, partition: 'a' };
    expect(pickerLabel(session, [session])).toBe('Tab 1');
  });

  it('falls back to just the name for a URL with no host (e.g. a local file:// page)', () => {
    const session = { id: 'a', name: 'New Tab', url: 'file:///app/renderer/newtab.html', partition: 'a' };
    expect(pickerLabel(session, [session])).toBe('New Tab');
  });

  it('falls back to just the name for an unparseable URL', () => {
    const session = { id: 'a', name: 'Tab 1', url: 'not a url', partition: 'a' };
    expect(pickerLabel(session, [session])).toBe('Tab 1');
  });

  it('appends "· shared session" when another open session has the same partition', () => {
    const a = { id: 'a', name: 'Tab A', url: 'https://example.com/', partition: 'persist:shared' };
    const b = { id: 'b', name: 'Tab B', url: 'https://example.com/other', partition: 'persist:shared' };
    expect(pickerLabel(a, [a, b])).toBe('Tab A — example.com · shared session');
    expect(pickerLabel(b, [a, b])).toBe('Tab B — example.com · shared session');
  });

  it('does not flag a session as shared when no other open session has the same partition', () => {
    const a = { id: 'a', name: 'Tab A', url: 'https://example.com/', partition: 'a-only' };
    const b = { id: 'b', name: 'Tab B', url: 'https://example.com/', partition: 'b-only' };
    expect(pickerLabel(a, [a, b])).toBe('Tab A — example.com');
  });

  it('ignores the session\'s own entry in allSessions when checking for a shared partition', () => {
    const a = { id: 'a', name: 'Tab A', url: 'https://example.com/', partition: 'a' };
    expect(pickerLabel(a, [a])).toBe('Tab A — example.com');
  });
});
