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

// #321: cookie columns drop Path, then Flags, then Domain; Name (1) and Value (2) never hide.
describe('renderer/style.css cookie table columns', () => {
  it('hides only columns 4, 6, 3 responsively', () => {
    const hidden = [...css.matchAll(/\.storage-cookie-table[^{]*:nth-child\((\d)\) \{ display: none; \}/g)].map(m => m[1]);
    expect(hidden).toEqual(['4', '6', '3']);
  });
});

// #323: the not-connected Jira toolbar hides the ticket-key input and Load button.
describe('renderer/style.css Jira not-connected state', () => {
  it('hides the key field and Load button under .jira-unconfigured', () => {
    expect(css).toMatch(/\.jira-unconfigured \.jira-key-field, \.jira-unconfigured #jiraFetchBtn \{ display: none; \}/);
  });
});

// #339: Network chips keep a 4px label/count gap.
describe('renderer/style.css Network chips', () => {
  it('uses a 4px gap between label and count', () => {
    expect(css).toMatch(/#networkPills \.filter-pill \{[^}]*gap: 4px/);
    expect(css).toMatch(/#networkPills \.pill-count \{ margin-left: 0; \}/);
  });
});
