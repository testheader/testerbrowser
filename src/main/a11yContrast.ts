// Pure, DOM-free WCAG 2.x contrast math — kept separate from sessionManager's
// page-walking so the formulas themselves are directly unit-testable without
// an Electron/CDP session. The actual DOM walk (resolving each element's
// effective background through its ancestor chain) happens in-page via
// executeJavaScript; this module only scores the colors it's handed back.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3;
export const WCAG_AAA_NORMAL = 7;
export const WCAG_AAA_LARGE = 4.5;

function channelLuminance(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(rgb1: RGB, rgb2: RGB): number {
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG's "large text" bar: >=24px at any weight, or >=18.66px (~14pt) at
// bold (>=700) weight.
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  if (fontSizePx >= 24) return true;
  return fontSizePx >= 18.66 && fontWeight >= 700;
}

// Parses a getComputedStyle() color string — "rgb(r, g, b)" or
// "rgba(r, g, b, a)" is what every browser normalizes color/background-color
// to, regardless of how the CSS was authored. A fully transparent color
// (alpha 0) has no usable RGB for contrast purposes, so it parses to null
// the same as unparseable input — callers should already have walked past
// transparent backgrounds before this is called, so it should not see one
// in practice; text color's own alpha (rare) is not composited and is used
// as-is, which is an accepted approximation, not exact WCAG compositing.
export function parseCssColor(input: string | null | undefined): RGB | null {
  if (!input) return null;
  const m = input.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return null;
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  if (a === 0) return null;
  return {
    r: Math.round(parseFloat(m[1])),
    g: Math.round(parseFloat(m[2])),
    b: Math.round(parseFloat(m[3])),
  };
}
