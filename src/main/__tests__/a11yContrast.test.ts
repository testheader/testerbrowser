import { relativeLuminance, contrastRatio, isLargeText, parseCssColor } from '../a11yContrast';

describe('relativeLuminance / contrastRatio (#194 — WCAG contrast checker)', () => {
  it('pure black vs pure white is 21:1', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 1); // order-independent
  });

  it('a color against itself is 1:1', () => {
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it('a known borderline-AA pair (#767676 on white) is ~4.5:1', () => {
    // #767676 (118,118,118) on white is the textbook "just passes AA normal
    // text" gray WCAG documentation itself uses as the 4.5:1 example.
    const gray = { r: 118, g: 118, b: 118 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(gray, white)).toBeCloseTo(4.5, 1);
  });

  it('a low-contrast pair fails 4.5:1', () => {
    const lightGray = { r: 200, g: 200, b: 200 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(lightGray, white)).toBeLessThan(4.5);
  });
});

describe('isLargeText', () => {
  it('18px normal weight is not large', () => {
    expect(isLargeText(18, 400)).toBe(false);
  });

  it('24px is large regardless of weight', () => {
    expect(isLargeText(24, 400)).toBe(true);
  });

  it('14pt (~18.66px) bold is large', () => {
    expect(isLargeText(18.66, 700)).toBe(true);
  });

  it('14pt (~18.66px) at normal weight is not large', () => {
    expect(isLargeText(18.66, 400)).toBe(false);
  });

  it('just under the bold threshold is not large', () => {
    expect(isLargeText(18, 700)).toBe(false);
  });
});

describe('parseCssColor', () => {
  it('parses rgb()', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses rgba() with alpha, ignoring alpha in the returned RGB', () => {
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('returns null for a fully transparent color', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor(null)).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });
});
