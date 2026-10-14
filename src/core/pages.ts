// Pages: editable non-song pages for songbooks (cover, quote, notes...).
//
// A page is a YAML file (.page.yaml) with a list of elements stacked from
// top to bottom. Heights can be fixed (in points) or "fill", to share the space
// left on the page:
//
//   elements:
//     - text: "{{title}}"
//       font: LiberationSans-Bold
//       size: 34
//       align: center
//     - image: images/logo.png
//       height: fill
//     - box: "Nome:"
//       height: 46
//       radius: 10
//
// Placeholders: {{title}} (songbook title), {{year}}, {{date}}.

import YAML from 'yaml';
import type { FontRegistry } from './fonts';
import type { DrawItem, LaidPage } from './layout';

export type Align = 'left' | 'center' | 'right';
export type Height = number | 'fill';

interface Common {
  /** Space above the element, in points. */
  margin?: number;
}
export interface TextElement extends Common {
  text: string;
  font?: string;
  size?: number;
  align?: Align;
  /** Line height as a multiple of the size. */
  line_height?: number;
  /** Left indent, in points. */
  indent?: number;
}
export interface ImageElement extends Common {
  image: string;
  height?: Height;
  /** Maximum width as a fraction of the page content width (0–1). */
  width?: number;
  align?: Align;
}
export interface BoxElement extends Common {
  /** Label printed inside the top of the box (may be empty). */
  box: string;
  height?: Height;
  radius?: number;
  line_width?: number;
  font?: string;
  size?: number;
  align?: Align;
}
export interface LinesElement extends Common {
  /** Ruled lines for writing: a number of lines or "fill". */
  lines: number | 'fill';
  spacing?: number;
}
export interface SpaceElement {
  space: Height;
}
export interface RuleElement extends Common {
  rule: true;
  line_width?: number;
}

export type PageElement = TextElement | ImageElement | BoxElement | LinesElement | SpaceElement | RuleElement;

export interface PageDoc {
  /** Page margin in points (default: the song margins). */
  margin?: number;
  elements: PageElement[];
}

export type ElementKind = 'text' | 'image' | 'box' | 'lines' | 'space' | 'rule';

export function elementKind(e: PageElement): ElementKind {
  if ('text' in e) return 'text';
  if ('image' in e) return 'image';
  if ('box' in e) return 'box';
  if ('lines' in e) return 'lines';
  if ('rule' in e) return 'rule';
  return 'space';
}

export function parsePage(src: string): PageDoc {
  const y = (YAML.parse(src) ?? {}) as Partial<PageDoc>;
  return { margin: y.margin, elements: Array.isArray(y.elements) ? y.elements : [] };
}

export function serializePage(t: PageDoc): string {
  const out: Record<string, unknown> = {};
  if (t.margin !== undefined) out.margin = t.margin;
  out.elements = t.elements;
  return YAML.stringify(out);
}

export interface PageVars {
  title: string;
  date?: Date;
}

function fill(text: string, vars: PageVars): string {
  const d = vars.date ?? new Date();
  return text
    .replace(/\{\{\s*title\s*\}\}/g, vars.title)
    .replace(/\{\{\s*year\s*\}\}/g, String(d.getFullYear()))
    .replace(/\{\{\s*date\s*\}\}/g, d.toLocaleDateString());
}

export interface PageLayoutContext {
  fonts: FontRegistry;
  width: number;
  height: number;
  defaultMargin: number;
  defaultFont: string;
  vars: PageVars;
  /** Pixel size of each image referenced by the page (missing: skipped). */
  imageSizes: Record<string, { width: number; height: number }>;
}

/** Word-wrap a paragraph to a maximum width. */
function wrap(fonts: FontRegistry, font: string, size: number, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && fonts.width(font, size, next.trimEnd()) > maxWidth) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function layoutPage(t: PageDoc, ctx: PageLayoutContext): LaidPage {
  const { fonts, width, height } = ctx;
  const m = t.margin ?? ctx.defaultMargin;
  const innerW = width - 2 * m;
  const fontOf = (f?: string) => (f && fonts.has(f) ? f : ctx.defaultFont);

  // First pass: fixed heights, and how many elements share the free space.
  type Measured = { el: PageElement; fixed: number; fills: boolean; lines?: string[] };
  const measured: Measured[] = t.elements.map((el) => {
    const margin = 'margin' in el ? (el.margin ?? 0) : 0;
    switch (elementKind(el)) {
      case 'text': {
        const e = el as TextElement;
        const size = e.size ?? 12;
        const lines = wrap(fonts, fontOf(e.font), size, fill(e.text ?? '', ctx.vars), innerW - (e.indent ?? 0));
        return { el, fixed: margin + lines.length * size * (e.line_height ?? 1.25), fills: false, lines };
      }
      case 'image': {
        const e = el as ImageElement;
        const sz = ctx.imageSizes[e.image];
        if (e.height === 'fill' || e.height === undefined) return { el, fixed: margin, fills: true };
        return { el, fixed: margin + (sz ? e.height : 0), fills: false };
      }
      case 'box': {
        const e = el as BoxElement;
        return { el, fixed: margin + (e.height === 'fill' || e.height === undefined ? 0 : e.height), fills: e.height === 'fill' || e.height === undefined };
      }
      case 'lines': {
        const e = el as LinesElement;
        const sp = e.spacing ?? 20;
        return { el, fixed: margin + (e.lines === 'fill' ? 0 : e.lines * sp), fills: e.lines === 'fill' };
      }
      case 'space': {
        const e = el as SpaceElement;
        return { el, fixed: e.space === 'fill' ? 0 : e.space, fills: e.space === 'fill' };
      }
      case 'rule':
        return { el, fixed: margin + ((el as RuleElement).line_width ?? 0.8), fills: false };
    }
  });
  const fixedTotal = measured.reduce((h, x) => h + x.fixed, 0);
  const fillers = measured.filter((x) => x.fills).length;
  const share = fillers ? Math.max(0, height - 2 * m - fixedTotal) / fillers : 0;

  const items: DrawItem[] = [];
  let y = m;
  const alignX = (w: number, align: Align | undefined, indent = 0) =>
    align === 'center' ? m + (innerW - w) / 2 : align === 'right' ? m + innerW - w : m + indent;

  for (const x of measured) {
    const el = x.el;
    const margin = 'margin' in el ? (el.margin ?? 0) : 0;
    y += margin;
    switch (elementKind(el)) {
      case 'text': {
        const e = el as TextElement;
        const font = fontOf(e.font);
        const size = e.size ?? 12;
        const lh = size * (e.line_height ?? 1.25);
        for (const line of x.lines!) {
          const w = fonts.width(font, size, line);
          items.push({ type: 'text', x: alignX(w, e.align, e.indent), y: y + fonts.ascent(font, size), text: line, font, size, role: 'lyrics' });
          y += lh;
        }
        break;
      }
      case 'image': {
        const e = el as ImageElement;
        const sz = ctx.imageSizes[e.image];
        const boxH = x.fills ? share : (e.height as number);
        if (sz && boxH > 0) {
          const maxW = innerW * Math.min(1, e.width ?? 1);
          const k = Math.min(maxW / sz.width, boxH / sz.height);
          const w = sz.width * k;
          const h = sz.height * k;
          items.push({ type: 'image', x: alignX(w, e.align ?? 'center'), y: y + (boxH - h) / 2, width: w, height: h, src: e.image });
        }
        y += x.fills ? share : sz ? boxH : 0;
        break;
      }
      case 'box': {
        const e = el as BoxElement;
        const h = x.fills ? share : (e.height as number);
        const r = Math.min(e.radius ?? 8, h / 2, innerW / 2);
        items.push({ type: 'rect', x: m, y, width: innerW, height: h, radius: r, lineWidth: e.line_width ?? 1.2 });
        if (e.box) {
          const font = fontOf(e.font);
          const size = e.size ?? 13;
          const label = fill(e.box, ctx.vars);
          const pad = Math.max(8, r * 0.6);
          const w = fonts.width(font, size, label);
          const lx = e.align === 'center' ? m + (innerW - w) / 2 : e.align === 'right' ? m + innerW - pad - w : m + pad;
          const ly = h < size * 4.5 ? y + (h + fonts.ascent(font, size) * 0.8) / 2 : y + pad + fonts.ascent(font, size);
          items.push({ type: 'text', x: lx, y: ly, text: label, font, size, role: 'lyrics' });
        }
        y += h;
        break;
      }
      case 'lines': {
        const e = el as LinesElement;
        const sp = e.spacing ?? 20;
        const n = e.lines === 'fill' ? Math.floor(share / sp) : e.lines;
        for (let i = 1; i <= n; i++) items.push({ type: 'rule', x1: m, y1: y + i * sp, x2: m + innerW, y2: y + i * sp, width: 0.4 });
        y += e.lines === 'fill' ? share : n * sp;
        break;
      }
      case 'space':
        y += x.fills ? share : ((el as SpaceElement).space as number);
        break;
      case 'rule': {
        const lw = (el as RuleElement).line_width ?? 0.8;
        items.push({ type: 'rule', x1: m, y1: y + lw / 2, x2: m + innerW, y2: y + lw / 2, width: lw });
        y += lw;
        break;
      }
    }
  }
  return { width, height, items };
}

/** Images referenced by a page, to load their sizes before layout. */
export function pageImages(t: PageDoc): string[] {
  return t.elements.filter((e): e is ImageElement => 'image' in e && !!e.image).map((e) => e.image);
}

// --- Starter templates: initial content for new pages ---------------------

export type TemplateName = 'cover' | 'quote' | 'notes' | 'lines' | 'empty';

const STARTERS: Record<'en' | 'it', Record<TemplateName, PageDoc>> = {
  it: {
    cover: {
      elements: [
        { space: 20 },
        { text: '{{title}}', font: 'LiberationSans-Bold', size: 34, align: 'center' },
        { space: 'fill' },
        { box: 'Nome:', height: 46, radius: 10, font: 'LiberationSerif-Italic', size: 14 },
      ],
    },
    quote: {
      elements: [
        { space: 'fill' },
        {
          text: 'Cercate di lasciare questo mondo\nun po’ migliore\ndi quanto non l’avete trovato.',
          font: 'LiberationSerif-Italic',
          size: 16,
          line_height: 2,
          indent: 20,
        },
        { text: '– B.-P.', font: 'LiberationSerif-Italic', size: 14, align: 'right', margin: 16 },
        { space: 'fill' },
      ],
    },
    notes: { elements: [{ box: 'Questo spazio è per me…', height: 'fill', radius: 36, font: 'LiberationSerif-Italic', size: 14, align: 'center' }] },
    lines: { elements: [{ text: 'Appunti', font: 'LiberationSerif-Bold', size: 14 }, { lines: 'fill', spacing: 22, margin: 6 }] },
    empty: { elements: [] },
  },
  en: {
    cover: {
      elements: [
        { space: 20 },
        { text: '{{title}}', font: 'LiberationSans-Bold', size: 34, align: 'center' },
        { space: 'fill' },
        { box: 'Name:', height: 46, radius: 10, font: 'LiberationSerif-Italic', size: 14 },
      ],
    },
    quote: {
      elements: [
        { space: 'fill' },
        {
          text: 'Try and leave this world\na little better\nthan you found it.',
          font: 'LiberationSerif-Italic',
          size: 16,
          line_height: 2,
          indent: 20,
        },
        { text: '– B.-P.', font: 'LiberationSerif-Italic', size: 14, align: 'right', margin: 16 },
        { space: 'fill' },
      ],
    },
    notes: { elements: [{ box: 'This space is for me…', height: 'fill', radius: 36, font: 'LiberationSerif-Italic', size: 14, align: 'center' }] },
    lines: { elements: [{ text: 'Notes', font: 'LiberationSerif-Bold', size: 14 }, { lines: 'fill', spacing: 22, margin: 6 }] },
    empty: { elements: [] },
  },
};

export function starterTemplate(name: TemplateName, lang: 'en' | 'it'): PageDoc {
  return structuredClone(STARTERS[lang][name]);
}
