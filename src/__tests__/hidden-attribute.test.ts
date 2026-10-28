import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'style.css'), 'utf8');

// Class rules that set `display` beat the UA [hidden] rule, so elements the code marks
// hidden (Jira add-bug bar/form, Record run view) would still render without this.
describe('renderer/style.css [hidden]', () => {
  it('has a global [hidden] rule that wins over class display rules', () => {
    expect(css).toMatch(/^\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/m);
  });
});
