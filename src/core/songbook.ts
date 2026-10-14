// Songbook: a YAML file listing the songs (ChordPro files) and other pages that
// make up a booklet, plus the print settings. Example:
//
//   title: Canzoniere Campo 2026
//   page: A5
//   imposition: booklet      # single | copies | 2up | booklet
//   notation: original       # original (as written) | italian | english
//   contents:
//     - image: images/cover.png
//     - toc: Indice
//     - song: songs/al-fuoco-di-bivacco.cho
//     - song: songs/insieme.cho
//       columns: 2

import YAML from 'yaml';
import { parseSong } from './chordpro';
import type { Notation } from './chords';
import type { FontRegistry } from './fonts';
import { PAGE_SIZES, impose, type ImpositionKind, type PageSizeName, type Sheet } from './impose';
import { DEFAULT_STYLE, layoutSong, type Columns, type LaidPage, type SongStyle, type TextItem } from './layout';
import { imageSize } from './images';
import { layoutPage, parsePageTemplate, templateImages } from './pages';

export type ContentItem =
  | { song: string; columns?: Columns; scale?: number }
  | { image: string; caption?: string }
  | { page: string; page_number?: boolean }
  | { toc: string }
  | 'blank';

export interface Songbook {
  title: string;
  page: PageSizeName;
  imposition: ImpositionKind;
  /** Print every chord in one notation, or 'original' to keep them as written. */
  notation: Notation | 'original';
  columns: Columns;
  showChords: boolean;
  pageNumbers: boolean;
  /** Start songs longer than one page on a left page, so they can be read without turning. */
  keepSpreads: boolean;
  foldLine: boolean;
  style: SongStyle;
  contents: ContentItem[];
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeStyle(base: SongStyle, over: DeepPartial<SongStyle> | undefined): SongStyle {
  if (!over) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    out[k] = v && typeof v === 'object' && b && typeof b === 'object' ? { ...b, ...v } : v;
  }
  return out as unknown as SongStyle;
}

export function defaultSongbook(): Songbook {
  return {
    title: '',
    page: 'A5',
    imposition: 'booklet',
    notation: 'original',
    columns: 'auto',
    showChords: true,
    pageNumbers: true,
    keepSpreads: true,
    foldLine: true,
    style: DEFAULT_STYLE,
    contents: [],
  };
}

export function parseSongbook(src: string): Songbook {
  const y = (YAML.parse(src) ?? {}) as Record<string, unknown>;
  const d = defaultSongbook();
  return {
    title: String(y.title ?? d.title),
    page: (y.page as PageSizeName) in PAGE_SIZES ? (y.page as PageSizeName) : d.page,
    imposition: (y.imposition as ImpositionKind) ?? d.imposition,
    notation: (['italian', 'english', 'original'].includes(y.notation as string) ? y.notation : d.notation) as Songbook['notation'],
    columns: (y.columns as Columns) ?? d.columns,
    showChords: (y.show_chords as boolean) ?? d.showChords,
    pageNumbers: (y.page_numbers as boolean) ?? d.pageNumbers,
    keepSpreads: (y.keep_spreads as boolean) ?? d.keepSpreads,
    foldLine: (y.fold_line as boolean) ?? d.foldLine,
    style: mergeStyle(d.style, y.style as DeepPartial<SongStyle>),
    contents: ((y.contents as ContentItem[]) ?? []).map((c) => (c === null ? 'blank' : c)),
  };
}

export function serializeSongbook(b: Songbook): string {
  const d = defaultSongbook();
  const y: Record<string, unknown> = { title: b.title, page: b.page, imposition: b.imposition };
  if (b.notation !== d.notation) y.notation = b.notation;
  if (b.columns !== d.columns) y.columns = b.columns;
  if (b.showChords !== d.showChords) y.show_chords = b.showChords;
  if (b.pageNumbers !== d.pageNumbers) y.page_numbers = b.pageNumbers;
  if (b.keepSpreads !== d.keepSpreads) y.keep_spreads = b.keepSpreads;
  if (b.foldLine !== d.foldLine) y.fold_line = b.foldLine;
  // Only write the style values that differ from the defaults.
  const style: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.style)) {
    const dv = (d.style as unknown as Record<string, unknown>)[k];
    if (v && typeof v === 'object') {
      const diff = Object.fromEntries(Object.entries(v).filter(([kk, vv]) => (dv as Record<string, unknown>)[kk] !== vv));
      if (Object.keys(diff).length) style[k] = diff;
    } else if (v !== dv) style[k] = v;
  }
  if (Object.keys(style).length) y.style = style;
  y.contents = b.contents;
  return YAML.stringify(y);
}

export interface FileLoader {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

export interface BuiltBook {
  pages: LaidPage[];
  sheets: Sheet[];
  /** Song title and first page number (1-based), in booklet order. */
  index: { title: string; page: number }[];
  warnings: string[];
}

interface PendingPage {
  page: LaidPage;
  folio: boolean;
}

function folio(fonts: FontRegistry, style: SongStyle, page: LaidPage, n: number): TextItem {
  const size = 8;
  const text = String(n);
  const w = fonts.width(style.lyrics.font, size, text);
  // Outer corner: right on odd (recto) pages, left on even (verso) pages.
  const x = n % 2 ? page.width - style.margin.right - w : style.margin.left;
  return { type: 'text', x, y: page.height - style.margin.bottom / 2, text, font: style.lyrics.font, size, role: 'folio' };
}

function tocPages(fonts: FontRegistry, book: Songbook, title: string, entries: { title: string; page: number }[]): LaidPage[] {
  const { width, height } = PAGE_SIZES[book.page];
  const st = book.style;
  const m = st.margin;
  const size = st.lyrics.size;
  const lh = size * 1.35;
  const pages: LaidPage[] = [];
  let page: LaidPage | null = null;
  let y = 0;
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const start = () => {
    page = { width, height, items: [] };
    pages.push(page);
    y = m.top;
    if (pages.length === 1) {
      const ts = st.title.size;
      page.items.push({ type: 'text', x: m.left, y: y + fonts.ascent(st.title.font, ts), text: title, font: st.title.font, size: ts, role: 'title' });
      y += ts * st.lineHeight + st.headerGap;
    }
  };
  start();
  for (const e of sorted) {
    if (y + lh > height - m.bottom) start();
    const num = String(e.page);
    const nw = fonts.width(st.lyrics.font, size, num);
    const asc = fonts.ascent(st.lyrics.font, size);
    page!.items.push({ type: 'text', x: m.left, y: y + asc, text: e.title, font: st.lyrics.font, size, role: 'lyrics' });
    page!.items.push({ type: 'text', x: width - m.right - nw, y: y + asc, text: num, font: st.lyrics.font, size, role: 'lyrics' });
    y += lh;
  }
  return pages;
}

async function imagePage(book: Songbook, loader: FileLoader, src: string): Promise<LaidPage> {
  const { width, height } = PAGE_SIZES[book.page];
  const m = book.style.margin;
  const bytes = await loader.readBytes(src);
  const size = imageSize(bytes);
  const maxW = width - m.left - m.right;
  const maxH = height - m.top - m.bottom;
  const k = Math.min(maxW / size.width, maxH / size.height);
  const w = size.width * k;
  const h = size.height * k;
  return { width, height, items: [{ type: 'image', x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, src }] };
}

export async function buildSongbook(book: Songbook, fonts: FontRegistry, loader: FileLoader): Promise<BuiltBook> {
  const { width, height } = PAGE_SIZES[book.page];
  const warnings: string[] = [];
  // First pass: everything but the table of contents, which needs page numbers.
  type Part = { kind: 'pages'; pages: PendingPage[]; title?: string } | { kind: 'toc'; title: string };
  const parts: Part[] = [];
  for (const item of book.contents) {
    if (item === 'blank') {
      parts.push({ kind: 'pages', pages: [{ page: { width, height, items: [] }, folio: false }] });
    } else if ('song' in item) {
      try {
        const doc = parseSong(await loader.readText(item.song));
        const laid = layoutSong(doc, fonts, book.style, {
          width,
          height,
          columns: item.columns ?? book.columns,
          notation: book.notation,
          transpose: 0,
          showChords: book.showChords,
          scale: item.scale,
        });
        parts.push({ kind: 'pages', title: laid.title || item.song, pages: laid.pages.map((p) => ({ page: p, folio: true })) });
      } catch (e) {
        warnings.push(`${item.song}: ${(e as Error).message}`);
      }
    } else if ('page' in item) {
      try {
        const t = parsePageTemplate(await loader.readText(item.page));
        const imageSizes: Record<string, { width: number; height: number }> = {};
        for (const src of templateImages(t)) {
          try {
            imageSizes[src] = imageSize(await loader.readBytes(src));
          } catch (e) {
            warnings.push(`${item.page}: ${src}: ${(e as Error).message}`);
          }
        }
        const page = layoutPage(t, {
          fonts,
          width,
          height,
          defaultMargin: book.style.margin.left,
          defaultFont: book.style.lyrics.font,
          vars: { title: book.title },
          imageSizes,
        });
        parts.push({ kind: 'pages', pages: [{ page, folio: !!item.page_number }] });
      } catch (e) {
        warnings.push(`${item.page}: ${(e as Error).message}`);
      }
    } else if ('image' in item) {
      try {
        parts.push({ kind: 'pages', pages: [{ page: await imagePage(book, loader, item.image), folio: false }] });
      } catch (e) {
        warnings.push(`${item.image}: ${(e as Error).message}`);
      }
    } else if ('toc' in item) {
      parts.push({ kind: 'toc', title: item.toc || 'Index' });
    }
  }

  // Number pages, given how many pages each table of contents takes.
  const paginate = (tocSizes: number[]) => {
    const index: { title: string; page: number }[] = [];
    const out: (PendingPage | { toc: number })[] = [];
    let t = 0;
    for (const part of parts) {
      if (part.kind === 'toc') {
        for (let i = 0; i < tocSizes[t]; i++) out.push({ toc: t });
        t++;
        continue;
      }
      // A multi-page song should start on a left (even) page.
      if (book.keepSpreads && part.title && part.pages.length === 2 && (out.length + 1) % 2 === 1) {
        out.push({ page: { width, height, items: [] }, folio: false });
      }
      if (part.title) index.push({ title: part.title, page: out.length + 1 });
      out.push(...part.pages);
    }
    return { index, out };
  };
  const tocTitles = parts.filter((p): p is Extract<Part, { kind: 'toc' }> => p.kind === 'toc').map((p) => p.title);
  let sizes = tocTitles.map(() => 1);
  let pass = paginate(sizes);
  for (let iter = 0; iter < 3; iter++) {
    const next = tocTitles.map((t) => tocPages(fonts, book, t, pass.index).length);
    if (next.every((n, i) => n === sizes[i])) break;
    sizes = next;
    pass = paginate(sizes);
  }
  // Booklets need a multiple of 4 pages: when the book ends with a template or
  // image page (a back cover), pad before it so that it stays at the back.
  const n = pass.out.length;
  const last = pass.out[n - 1];
  if (book.imposition === 'booklet' && n > 2 && n % 4 && last && 'page' in last && !last.folio) {
    const pad = 4 - (n % 4);
    pass.out.splice(n - 1, 0, ...Array.from({ length: pad }, () => ({ page: { width, height, items: [] }, folio: false })));
  }
  const tocs = tocTitles.map((t) => tocPages(fonts, book, t, pass.index));
  const tocCursor = tocTitles.map(() => 0);

  const pages: LaidPage[] = pass.out.map((p, i) => {
    if ('toc' in p) return tocs[p.toc][tocCursor[p.toc]++];
    if (!p.folio || !book.pageNumbers) return p.page;
    return { ...p.page, items: [...p.page.items, folio(fonts, book.style, p.page, i + 1)] };
  });
  const sheets = impose(pages, { kind: book.imposition, foldLine: book.foldLine });
  return { pages, sheets, index: pass.index, warnings };
}
