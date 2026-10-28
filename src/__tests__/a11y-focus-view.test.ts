import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'a11y.js'), 'utf8');

// #342: Focus is its own A11y view; focus order and focus trap are functions inside it.
describe('A11y Focus view', () => {
  it('is registered as a view with a chip', () => {
    expect(src).toMatch(/focus:\s+\{ btnId: 'a11yViewFocusBtn'/);
    expect(src).toContain('id="a11yViewFocusBtn" data-view="focus"');
  });

  it('keeps focus order and focus trap as buttons shown only in the Focus view', () => {
    expect(src).toMatch(/class="a11y-btn a11y-focus-only" id="a11yFocusOrderBtn" hidden/);
    expect(src).toMatch(/class="a11y-btn a11y-focus-only" id="a11yFocusTrapBtn" hidden/);
    expect(src).toContain(".hidden = view !== 'focus'");
  });
});
