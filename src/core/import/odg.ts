// OpenDocument Drawing (.odg) reader for songbooks laid out in LibreOffice Draw.
//
// Expected layout: landscape sheets, each holding two pages side by side (left and
// right half). A half with an embedded text document (a song, chords above lyrics)
// becomes a song; a half with text boxes, shapes and pictures becomes a page
// (.page.yaml); an empty half becomes a blank page. Pictures next to songs are ignored.
//
// The sheets can be in reading order (pages 1|2, 3|4, …) or already arranged as a
// booklet for printing (n|1, 2|n-1, n-2|3, …).

import { strFromU8, unzipSync } from 'fflate';
import { fontVariant, type FontRegistry } from '../fonts';
import { PAGE_SIZES, type PageSizeName } from '../impose';
import type { Align, BoxElement, ImageElement, PageDoc, PageElement, TextElement } from '../pages';
import { readOdtXml, registryFamily, Styles, toPt, type TextProps } from './odt';
import { convertSheet } from './sheet';
import { child, elements, parseXml, type XmlElement } from './xml';
import { getMeta, parseSong } from '../chordpro';

export type BookPart =
  | { kind: 'song'; page: number; title: string; chordpro: string }
  | { kind: 'page'; page: number; name: string; doc: PageDoc }
  | { kind: 'blank'; page: number };

export interface ImportedBook {
  title: string;
  /** Page size closest to one half of a sheet. */
  pageSize: PageSizeName;
  /** Book parts in reading order; `page` is the page number in the book (1-based). */
  parts: BookPart[];
  /** Pictures used by the pages, by their path inside the .odg (as referenced by the pages). */
  images: Record<string, Uint8Array>;
}

export interface OdgOptions {
  /** The sheets are already arranged as a booklet (default: true). */
  booklet?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drawing element on a page, with its position in points. */
interface Shape extends Box {
  el: XmlElement;
  kind: 'object' | 'image' | 'text' | 'rect';
}

const geometry = (el: XmlElement): Box => ({
  x: toPt(el.attrs['svg:x']) ?? 0,
  y: toPt(el.attrs['svg:y']) ?? 0,
  w: toPt(el.attrs['svg:width']) ?? 0,
  h: toPt(el.attrs['svg:height']) ?? 0,
});

function shapesOf(page: XmlElement): Shape[] {
  const out: Shape[] = [];
  for (const el of page.children) {
    if (typeof el === 'string') continue;
    if (el.name === 'draw:frame') {
      const obj = child(el, 'draw:object');
      const img = child(el, 'draw:image');
      const box = child(el, 'draw:text-box');
      const kind = obj ? 'object' : img ? 'image' : box ? 'text' : null;
      if (kind) out.push({ ...geometry(el), el, kind });
    } else if (el.name === 'draw:custom-shape' || el.name === 'draw:rect') {
      out.push({ ...geometry(el), el, kind: 'rect' });
    }
  }
  return out;
}

const inside = (a: Box, b: Box) => a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;

/** Order of the halves in the book: for each sheet, the page numbers (0-based) of its halves. */
function pageNumbers(sheets: number, halves: number, booklet: boolean): number[][] {
  const n = sheets * halves;
  return Array.from({ length: sheets }, (_, i) => {
    if (halves === 1) return [i];
    if (!booklet) return [2 * i, 2 * i + 1];
    // Front sides (even sheets) hold the last and first pages, back sides the reverse.
    return i % 2 === 0 ? [n - 1 - i, i] : [i, n - 1 - i];
  });
}

function closestSize(w: number, h: number): PageSizeName {
  let best: PageSizeName = 'A5';
  let err = Infinity;
  for (const [name, s] of Object.entries(PAGE_SIZES)) {
    const e = Math.abs(s.width - w) + Math.abs(s.height - h);
    if (e < err) [best, err] = [name as PageSizeName, e];
  }
  return best;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .replace(/-$/, '') || 'pagina'
  );
}

export function importOdg(name: string, bytes: Uint8Array, fonts: FontRegistry, opts: OdgOptions = {}): ImportedBook {
  const files = unzipSync(bytes);
  if (!files['content.xml']) throw new Error('Not an OpenDocument file (content.xml missing)');
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
  const styles = new Styles();
  const stylesXml = text('styles.xml');
  const stylesDoc = stylesXml ? parseXml(stylesXml) : undefined;
  if (stylesDoc) styles.addDoc(stylesDoc);
  const content = parseXml(text('content.xml')!);
  styles.addDoc(content);

  // Sheet size: the first page layout (all sheets of these files share it).
  const layout = stylesDoc ? [...elements(stylesDoc, 'style:page-layout-properties')][0] : undefined;
  const sheetW = toPt(layout?.attrs['fo:page-width']) ?? 841.89;
  const sheetH = toPt(layout?.attrs['fo:page-height']) ?? 595.28;
  const halves = sheetW > sheetH ? 2 : 1;
  const pageW = sheetW / halves;

  const sheets = [...elements(content, 'draw:page')];
  const order = pageNumbers(sheets.length, halves, opts.booklet ?? true);
  const bookTitle = name.replace(/\.[^.]+$/, '');
  const parts: BookPart[] = [];
  const images: Record<string, Uint8Array> = {};

  sheets.forEach((sheet, s) => {
    const all = shapesOf(sheet);
    for (let h = 0; h < halves; h++) {
      const page = order[s][h] + 1;
      const x0 = h * pageW;
      // Each shape belongs to the half holding its centre; positions become relative to the half.
      const mine = all.filter((sh) => Math.min(halves - 1, Math.max(0, Math.floor((sh.x + sh.w / 2) / pageW))) === h).map((sh) => ({ ...sh, x: sh.x - x0 }));
      const songs = mine.filter((sh) => sh.kind === 'object').sort((a, b) => a.y - b.y || a.x - b.x);
      if (songs.length) {
        for (const sh of songs) {
          const dir = (child(sh.el, 'draw:object')!.attrs['xlink:href'] ?? '').replace(/^\.\//, '').replace(/\/$/, '');
          const c = text(`${dir}/content.xml`);
          if (!c || !c.includes('office:text')) continue;
          const fallbackTitle = `${bookTitle} ${page}`;
          const chordpro = convertSheet(readOdtXml(c, text(`${dir}/styles.xml`), fonts), { fallbackTitle, indentStep: 20 });
          parts.push({ kind: 'song', page, title: getMeta(parseSong(chordpro), 'title') || fallbackTitle, chordpro });
        }
        continue;
      }
      const doc = pageFromShapes(mine, pageW, sheetH, styles, fonts, (href) => {
        if (files[href]) images[href] = files[href];
        return !!files[href];
      });
      if (!doc) parts.push({ kind: 'blank', page });
      else {
        const first = doc.elements.find((e) => 'text' in e || ('box' in e && e.box)) as { text?: string; box?: string } | undefined;
        parts.push({ kind: 'page', page, name: slug((first?.text ?? first?.box ?? '').split('\n')[0]), doc });
      }
    }
  });

  parts.sort((a, b) => a.page - b.page);
  return { title: bookTitle, pageSize: closestSize(pageW, sheetH), parts, images };
}

/** Text of a text box, with the style of its first non-empty run. */
function readTextBox(frame: XmlElement, styles: Styles): { text: string; props: TextProps; align?: Align } {
  const base = styles.text(frame.attrs['draw:text-style-name'], styles.graphicText);
  const lines: string[] = [];
  let props: TextProps | undefined;
  let align: Align | undefined;
  for (const p of elements(frame, 'text:p')) {
    const pStyle = p.attrs['text:style-name'];
    const pProps = styles.text(pStyle, base);
    let line = '';
    const walk = (el: XmlElement, tp: TextProps) => {
      for (const c of el.children) {
        if (typeof c === 'string') {
          const t = c.replace(/[\t\n\r ]+/g, ' ');
          if (t.trim() && !props) props = tp;
          line += t;
        } else if (c.name === 'text:s') line += ' '.repeat(parseInt(c.attrs['text:c'] ?? '1') || 1);
        else if (c.name === 'text:tab') line += ' ';
        else if (c.name === 'text:line-break') line += '\n';
        else if (c.name === 'text:span' || c.name === 'text:a') walk(c, styles.text(c.attrs['text:style-name'], tp));
      }
    };
    walk(p, pProps);
    if (line.trim() && !align) {
      const a = styles.para(pStyle).align ?? styles.para(frame.attrs['draw:text-style-name']).align;
      align = a === 'center' || a === 'right' ? a : 'left';
    }
    lines.push(line.trim());
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  return { text: lines.join('\n'), props: props ?? base, align };
}

/** A page made of the text boxes, rounded rectangles and pictures of one half; null if empty. */
function pageFromShapes(
  shapes: Shape[],
  pageW: number,
  pageH: number,
  styles: Styles,
  fonts: FontRegistry,
  useImage: (href: string) => boolean,
): PageDoc | null {
  const rects = shapes.filter((s) => s.kind === 'rect');
  const texts = shapes.filter((s) => s.kind === 'text').map((s) => ({ ...s, box: readTextBox(s.el, styles) })).filter((s) => s.box.text);
  const pics = shapes.filter((s) => s.kind === 'image');
  if (!rects.length && !texts.length && !pics.length) return null;

  const fontId = (p: TextProps) => fontVariant(fonts, registryFamily(fonts, styles.fontFamily(p.font)), !!p.bold, !!p.italic);
  const size = (p: TextProps) => Math.round((p.size ?? 18) * 10) / 10;
  // Page margin: the smallest side inset of the content, within reasonable bounds.
  const insets = shapes.flatMap((s) => [s.x, pageW - s.x - s.w]);
  const margin = Math.round(Math.min(57, Math.max(14, Math.min(...insets))));
  const innerW = pageW - 2 * margin;
  const alignOf = (s: Box): Align => {
    const centre = s.x + s.w / 2 - pageW / 2;
    if (Math.abs(centre) < pageW * 0.08) return 'center';
    return centre < 0 ? 'left' : 'right';
  };

  type Placed = { y: number; bottom: number; el: PageElement };
  const placed: Placed[] = [];
  const used = new Set<object>();
  for (const r of rects) {
    // A text box inside a rectangle becomes its label.
    const label = texts.find((t) => !used.has(t) && inside(t, r));
    if (label) used.add(label);
    const geo = child(r.el, 'draw:enhanced-geometry');
    const rounded = !geo || /round/.test(geo.attrs['draw:type'] ?? '');
    const mod = parseFloat(geo?.attrs['draw:modifiers'] ?? '3600') || 3600;
    const el: BoxElement = {
      box: label?.box.text ?? '',
      // A tall box reaching the bottom of the page takes the space left.
      height: pageH - (r.y + r.h) < 40 && r.h > pageH / 2 ? 'fill' : Math.round(r.h),
      radius: rounded ? Math.round((Math.min(r.w, r.h) * mod) / 21600) : 0,
    };
    if (label) {
      el.font = fontId(label.box.props);
      el.size = size(label.box.props);
      el.align = alignOf(label) === 'center' ? 'center' : 'left';
    }
    placed.push({ y: r.y, bottom: r.y + r.h, el });
  }
  for (const t of texts) {
    if (used.has(t)) continue;
    const align = t.box.align;
    const el: TextElement = { text: t.box.text, font: fontId(t.box.props), size: size(t.box.props) };
    if (align && align !== 'left') el.align = align;
    else if (t.x - margin > 4) el.indent = Math.round(t.x - margin);
    placed.push({ y: t.y, bottom: t.y + t.h, el });
  }
  for (const p of pics) {
    const href = child(p.el, 'draw:image')!.attrs['xlink:href'] ?? '';
    if (!useImage(href)) continue;
    const el: ImageElement = { image: href, height: Math.round(p.h), width: Math.min(1, Math.round((p.w / innerW) * 100) / 100), align: alignOf(p) };
    placed.push({ y: p.y, bottom: p.y + p.h, el });
  }

  // Stack from top to bottom, keeping the vertical gaps as space above each element.
  placed.sort((a, b) => a.y - b.y);
  let y = margin;
  const out: PageElement[] = [];
  for (const p of placed) {
    const gap = Math.round(p.y - y);
    if (gap > 2 && !('space' in p.el)) (p.el as { margin?: number }).margin = gap;
    out.push(p.el);
    y = Math.max(y, p.bottom);
  }
  return { margin, elements: out };
}
