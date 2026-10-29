import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'a11y.js'), 'utf8');

// #342: Focus is its own A11y view; focus order and focus trap are functions inside it.
describe('A11y Focus view', () => {
  it('is registered as a view with a chip', () => {
    expect(src).toMatch(/focus:\s+\{ btnId: 'a11yViewFocusBtn'/);
    expect(src).toContain('id="a11yViewFocusBtn" data-view="focus"');
  });

  it('keeps focus order and focus trap as buttons in a context group shown only in the Focus view (#348)', () => {
    expect(src).toMatch(/<div class="a11y-ctx-group" data-ctx="focus" hidden>\s*<button class="a11y-btn" id="a11yFocusOrderBtn"/);
    expect(src).toMatch(/<button class="a11y-btn" id="a11yFocusTrapBtn"/);
    expect(src).toContain('.dataset.ctx !== view');
  });
});
