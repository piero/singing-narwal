// Font registry shared by the layout engine (text measurement) and the PDF
// writer (embedding). Fonts are identified by an id, by convention the file name
// without extension (e.g. "LiberationSerif-Bold").
//
// Both the preview and the PDF use the same metrics, so what you see while
// editing is what gets printed.

import fontkit from '@pdf-lib/fontkit';

export const BUNDLED_FONTS = [
  'LiberationSerif-Regular',
  'LiberationSerif-Bold',
  'LiberationSerif-Italic',
  'LiberationSerif-BoldItalic',
  'LiberationSans-Regular',
  'LiberationSans-Bold',
  'LiberationSans-Italic',
  'LiberationSans-BoldItalic',
  'LiberationMono-Regular',
  'LiberationMono-Bold',
  'LiberationMono-Italic',
  'LiberationMono-BoldItalic',
];

interface FontkitFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  layout(text: string): { advanceWidth: number };
}

export class FontRegistry {
  private bytes = new Map<string, Uint8Array>();
  private faces = new Map<string, FontkitFont>();
  private widthCache = new Map<string, number>();

  add(id: string, data: Uint8Array) {
    this.bytes.set(id, data);
    this.faces.set(id, fontkit.create(data) as unknown as FontkitFont);
  }

  has(id: string) {
    return this.bytes.has(id);
  }

  ids() {
    return [...this.bytes.keys()];
  }

  data(id: string): Uint8Array {
    const b = this.bytes.get(id);
    if (!b) throw new Error(`Unknown font: ${id}`);
    return b;
  }

  private face(id: string): FontkitFont {
    const f = this.faces.get(id);
    if (!f) throw new Error(`Unknown font: ${id}`);
    return f;
  }

  /** Width of `text` in points at the given size. */
  width(id: string, size: number, text: string): number {
    const key = id + '\u0000' + text;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      const f = this.face(id);
      w = f.layout(text).advanceWidth / f.unitsPerEm;
      this.widthCache.set(key, w);
    }
    return w * size;
  }

  /** Distance from baseline to the top of the tallest glyphs, in points. */
  ascent(id: string, size: number): number {
    const f = this.face(id);
    return (f.ascent / f.unitsPerEm) * size;
  }
}

const STYLE_SUFFIX = /-(Regular|Bold|Italic|BoldItalic|Oblique|BoldOblique)$/;

/** Family part of a font id: "LiberationSerif-BoldItalic" → "LiberationSerif". */
export function fontFamily(id: string): string {
  return id.replace(STYLE_SUFFIX, '');
}

/**
 * Best available id for a family and style, falling back to the regular face and
 * then to the default serif family.
 */
export function fontVariant(reg: FontRegistry, family: string, bold: boolean, italic: boolean): string {
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  for (const fam of [family, 'LiberationSerif']) {
    for (const id of [`${fam}-${style}`, bold ? `${fam}-Bold` : '', `${fam}-Regular`, fam]) {
      if (id && reg.has(id)) return id;
    }
  }
  return 'LiberationSerif-Regular';
}

/** Font families available in the registry, e.g. for a font picker. */
export function fontFamilies(reg: FontRegistry): string[] {
  return [...new Set(reg.ids().map(fontFamily))].sort();
}

export const isFontFile = (p: string) => /\.(ttf|otf)$/i.test(p);

/** Font id for a font file in the workspace: its file name without extension. */
export const fontIdForFile = (p: string) => p.split('/').pop()!.replace(/\.(ttf|otf)$/i, '');

/** Load the bundled fonts using an environment-specific byte loader. */
export async function loadBundledFonts(load: (file: string) => Promise<Uint8Array>): Promise<FontRegistry> {
  const reg = new FontRegistry();
  await Promise.all(BUNDLED_FONTS.map(async (id) => reg.add(id, await load(`${id}.ttf`))));
  return reg;
}
