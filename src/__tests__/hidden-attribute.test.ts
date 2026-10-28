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

// #320: the Network detail pane must never squeeze the request table below ~560px.
describe('renderer/style.css #detailPanel', () => {
  it('caps its width so the table keeps 560px, and overlays when narrow', () => {
    expect(css).toMatch(/#detailPanel \{[^}]*max-width: calc\(100% - 560px\)/);
    expect(css).toMatch(/@container \(max-width: 1040px\)[^{]*\{\s*#detailPanel\.open \{ position: absolute/);
  });
});
