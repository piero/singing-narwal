// Layout engine: turns a song into pages of positioned text ("display list").
//
// The same display list is drawn as SVG for the live preview and written to PDF
// for printing. All measurements are in PDF points (1/72 inch); y grows downwards
// from the top of the page.

import { getMeta, type SongDoc, type ChordAnchor } from './chordpro';
import { renderChord, spellingForKey, type Notation, type Spelling } from './chords';
import { fontVariant, type FontRegistry } from './fonts';

export interface TextStyle {
  font: string;
  size: number;
}

export interface SongStyle {
  title: TextStyle;
  subtitle: TextStyle;
  lyrics: TextStyle;
  chords: TextStyle;
  comment: TextStyle;
  label: TextStyle;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Vertical space between paragraphs (verses, choruses), in points. */
  blockGap: number;
  /** Space after the song header, in points. */
  headerGap: number;
  /** Left indent of choruses, in points. */
  chorusIndent: number;
  /** Indent of the continuation of a wrapped line, in points. */
  wrapIndent: number;
  /** Minimum horizontal space between two consecutive chords, in points. */
  chordSpacing: number;
  columnGap: number;
  titleAlign: 'left' | 'center';
  margin: { top: number; right: number; bottom: number; left: number };
  /** Smallest font scale the auto-fit may use. */
  minScale: number;
}

export const DEFAULT_STYLE: SongStyle = {
  title: { font: 'LiberationSerif-Bold', size: 16 },
  subtitle: { font: 'LiberationSerif-Italic', size: 10 },
  lyrics: { font: 'LiberationSerif-Regular', size: 11 },
  chords: { font: 'LiberationSerif-Bold', size: 9.5 },
  comment: { font: 'LiberationSerif-Italic', size: 11 },
  label: { font: 'LiberationSerif-Bold', size: 10 },
  lineHeight: 1.15,
  blockGap: 9,
  headerGap: 12,
  chorusIndent: 18,
  wrapIndent: 18,
  chordSpacing: 4,
  columnGap: 18,
  titleAlign: 'left',
  margin: { top: 30, right: 28, bottom: 28, left: 28 },
  minScale: 0.75,
};

const TEXT_STYLES = ['title', 'subtitle', 'lyrics', 'chords', 'comment', 'label'] as const;

/**
 * `style` with all text in another font family (keeping bold and italic) and sized
 * so that the lyrics are `size` points, the other text in proportion.
 */
export function withFont(style: SongStyle, fonts: FontRegistry, family: string, size: number): SongStyle {
  const k = size / style.lyrics.size;
  const out = { ...style };
  for (const key of TEXT_STYLES) {
    const s = style[key];
    out[key] = { font: fontVariant(fonts, family, /Bold/.test(s.font), /Italic|Oblique/.test(s.font)), size: s.size * k };
  }
  return out;
}

export type Columns = 1 | 2 | 'auto';

export interface LayoutOptions {
  width: number;
  height: number;
  columns: Columns;
  /** 'original' prints chords as written in the song. */
  notation: Notation | 'original';
  transpose: number;
  showChords: boolean;
  /** Fixed font scale; when omitted the engine picks the largest that minimises pages. */
  scale?: number;
}

export interface TextItem {
  type: 'text';
  x: number;
  /** Baseline position. */
  y: number;
  text: string;
  font: string;
  size: number;
  role: 'title' | 'subtitle' | 'lyrics' | 'chord' | 'comment' | 'label' | 'folio';
  /** Source line index, so the preview can jump to the editor. */
  line?: number;
}

export interface RuleItem {
  type: 'rule';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

export interface ImageItem {
  type: 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
}

/** Outlined rectangle with rounded corners. */
export interface RectItem {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  lineWidth: number;
}

export type DrawItem = TextItem | RuleItem | ImageItem | RectItem;

export interface LaidPage {
  width: number;
  height: number;
  items: DrawItem[];
}

export interface SongLayout {
  pages: LaidPage[];
  columns: 1 | 2;
  scale: number;
  title: string;
}

// ---------------------------------------------------------------------------
// Song structure

type BlockKind = 'verse' | 'chorus' | 'bridge' | 'tab' | 'plain';

interface LyricsRow {
  kind: 'lyrics';
  line: number;
  text: string;
  chords: ChordAnchor[];
  italic: boolean;
}
interface CommentRow {
  kind: 'comment';
  line: number;
  text: string;
}
type SourceRow = LyricsRow | CommentRow;

interface Block {
  kind: BlockKind;
  label?: string;
  rows: SourceRow[];
  breakBefore?: 'column' | 'page';
}

interface SongStructure {
  title: string;
  subtitle: string;
  key?: string;
  columns?: 1 | 2;
  blocks: Block[];
}

function isEnvStart(name: string): BlockKind | null {
  const m = /^start_of_(chorus|verse|bridge|tab|grid)$/.exec(name);
  if (!m) return null;
  return m[1] === 'grid' ? 'tab' : (m[1] as BlockKind);
}

export function structure(doc: SongDoc): SongStructure {
  const s: SongStructure = {
    title: getMeta(doc, 'title') ?? '',
    subtitle: [getMeta(doc, 'subtitle'), getMeta(doc, 'artist')].filter(Boolean).join(' – '),
    key: getMeta(doc, 'key'),
    blocks: [],
  };
  const cols = Number(getMeta(doc, 'columns'));
  if (cols === 1 || cols === 2) s.columns = cols;

  let env: BlockKind = 'plain';
  let envLabel: string | undefined;
  let current: Block | null = null;
  let pendingBreak: Block['breakBefore'];
  let lastChorus: Block | null = null;

  const close = () => {
    if (current && current.rows.length) {
      s.blocks.push(current);
      if (current.kind === 'chorus') lastChorus = current;
    }
    current = null;
  };
  const open = (): Block => {
    if (!current) {
      current = { kind: env, label: envLabel, rows: [], breakBefore: pendingBreak };
      envLabel = undefined; // the label is shown once, on the first paragraph
      pendingBreak = undefined;
    }
    return current;
  };

  doc.lines.forEach((l, i) => {
    switch (l.kind) {
      case 'empty':
        close();
        return;
      case 'comment':
        return;
      case 'lyrics':
        open().rows.push({ kind: 'lyrics', line: i, text: l.text, chords: l.chords, italic: false });
        return;
      case 'directive': {
        const start = isEnvStart(l.name);
        if (start) {
          close();
          env = start;
          envLabel = l.value || undefined;
          return;
        }
        if (l.name.startsWith('end_of_')) {
          close();
          env = 'plain';
          envLabel = undefined;
          return;
        }
        switch (l.name) {
          case 'comment':
          case 'comment_italic':
          case 'comment_box':
            open().rows.push({ kind: 'comment', line: i, text: l.value });
            return;
          case 'chorus': {
            // Reference to the chorus: print its first line followed by an ellipsis.
            close();
            const ref = lastChorus as Block | null;
            const first = ref?.rows.find((r): r is LyricsRow => r.kind === 'lyrics');
            const text = l.value || (first ? first.text.trimEnd().replace(/[.,;:!?…]*$/, '') + '…' : 'Chorus');
            s.blocks.push({
              kind: 'chorus',
              rows: [{ kind: 'lyrics', line: i, text, chords: [], italic: false }],
              breakBefore: pendingBreak,
            });
            pendingBreak = undefined;
            return;
          }
          case 'column_break':
            close();
            pendingBreak = 'column';
            return;
          case 'new_page':
          case 'new_physical_page':
            close();
            pendingBreak = 'page';
            return;
        }
      }
    }
  });
  close();
  return s;
}

// ---------------------------------------------------------------------------
// Line layout

interface Row {
  height: number;
  /** Items positioned relative to the row's top-left corner. */
  items: TextItem[];
}

interface Ctx {
  fonts: FontRegistry;
  style: SongStyle;
  scale: number;
  opts: LayoutOptions;
  spelling: Spelling;
}

function sz(ctx: Ctx, t: TextStyle) {
  return t.size * ctx.scale;
}

function chordText(ctx: Ctx, chord: string) {
  return renderChord(chord, { notation: ctx.opts.notation, transpose: ctx.opts.transpose, spelling: ctx.spelling });
}

// Words allowed around the chords of an instrumental line, besides a "Label:" and (notes).
const SECTION_WORD = /^(intro|outro|solo|strumentale|instrumental|finale|coda|interludio|interlude|bridge|ponte|rit\.?|ritornello|chorus|verse|strofa)$/i;
const MUSIC_SYMBOL = /^(x?\d+x?|[|/%.\-–…:]+)$/i;

/**
 * Instrumental lines ("Intro: [C] [G] (2x)") are printed with the chords inline: none of
 * their chords is on a letter, and the rest is a label, notes in parentheses or musical
 * symbols. A line with lyrics keeps its chords above, even if they sit on spaces.
 */
export function isInlineChordLine(text: string, chords: ChordAnchor[]): boolean {
  if (!chords.length) return false;
  if (!chords.every((c) => c.pos >= text.length || /\s/.test(text[c.pos]))) return false;
  let words = text.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  const label = words.findIndex((w) => w.endsWith(':'));
  if (label >= 0 && label < 3) words = words.slice(label + 1);
  return words.every((w) => MUSIC_SYMBOL.test(w) || SECTION_WORD.test(w));
}

function segments(text: string, chords: ChordAnchor[]) {
  const sorted = [...chords].sort((a, b) => a.pos - b.pos);
  const segs: { chord?: string; text: string }[] = [];
  if (!sorted.length || sorted[0].pos > 0) segs.push({ text: text.slice(0, sorted.length ? sorted[0].pos : text.length) });
  sorted.forEach((c, i) => {
    const pos = Math.min(c.pos, text.length);
    const end = i + 1 < sorted.length ? Math.min(sorted[i + 1].pos, text.length) : text.length;
    segs.push({ chord: c.chord, text: text.slice(pos, end) });
  });
  return segs;
}

function layoutInline(ctx: Ctx, row: LyricsRow): Row {
  const { fonts, style } = ctx;
  const size = sz(ctx, style.lyrics);
  const ascent = fonts.ascent(style.lyrics.font, size);
  const items: TextItem[] = [];
  let x = 0;
  for (const seg of segments(row.text, row.chords)) {
    if (seg.chord !== undefined && ctx.opts.showChords) {
      const t = chordText(ctx, seg.chord);
      items.push({ type: 'text', x, y: ascent, text: t, font: style.chords.font, size, role: 'chord', line: row.line });
      x += fonts.width(style.chords.font, size, t) + style.chordSpacing * ctx.scale;
    }
    if (seg.text) {
      items.push({ type: 'text', x, y: ascent, text: seg.text, font: style.lyrics.font, size, role: 'lyrics', line: row.line });
      x += fonts.width(style.lyrics.font, size, seg.text);
    }
  }
  return { height: size * style.lineHeight, items };
}

/** Lay out one line on a single row, returning its natural width. */
function layoutSingle(ctx: Ctx, row: LyricsRow): { row: Row; width: number } {
  const { fonts, style } = ctx;
  const lyr = row.italic ? style.comment : style.lyrics;
  const lsize = sz(ctx, lyr);
  const csize = sz(ctx, style.chords);
  const hasChords = ctx.opts.showChords && row.chords.length > 0;
  const chordH = hasChords ? csize * style.lineHeight : 0;
  const lyricBase = chordH + fonts.ascent(lyr.font, lsize);
  const chordBase = fonts.ascent(style.chords.font, csize);
  const items: TextItem[] = [];
  let x = 0;
  let chordEnd = 0;
  let prevText = '';
  for (const seg of segments(row.text, hasChords ? row.chords : [])) {
    if (seg.chord !== undefined) {
      const t = chordText(ctx, seg.chord);
      if (chordEnd > x) {
        // The chord does not fit above the previous syllable: open a gap in the
        // lyrics, marked with a hyphen when it splits a word.
        const hyphenW = fonts.width(lyr.font, lsize, '-');
        if (/\S$/.test(prevText) && /^\S/.test(seg.text) && chordEnd - x > 1.5 * hyphenW) {
          items.push({ type: 'text', x: (x + chordEnd - hyphenW) / 2, y: lyricBase, text: '-', font: lyr.font, size: lsize, role: 'lyrics', line: row.line });
        }
        x = chordEnd;
      }
      items.push({ type: 'text', x, y: chordBase, text: t, font: style.chords.font, size: csize, role: 'chord', line: row.line });
      chordEnd = x + fonts.width(style.chords.font, csize, t) + style.chordSpacing * ctx.scale;
    }
    if (seg.text) {
      items.push({ type: 'text', x, y: lyricBase, text: seg.text, font: lyr.font, size: lsize, role: row.italic ? 'comment' : 'lyrics', line: row.line });
      x += fonts.width(lyr.font, lsize, seg.text);
      prevText = seg.text;
    }
  }
  const width = Math.max(x, chordEnd - style.chordSpacing * ctx.scale);
  return { row: { height: chordH + lsize * style.lineHeight, items }, width };
}

function subLine(row: LyricsRow, a: number, b: number, includeEnd: boolean): LyricsRow {
  return {
    ...row,
    text: row.text.slice(a, b),
    chords: row.chords
      .filter((c) => c.pos >= a && (c.pos < b || (includeEnd && c.pos <= b)))
      .map((c) => ({ pos: c.pos - a, chord: c.chord })),
  };
}

/** Lay out a line, wrapping it at spaces when it is wider than `maxWidth`. */
function layoutLine(ctx: Ctx, row: LyricsRow, maxWidth: number): Row[] {
  if (isInlineChordLine(row.text, row.chords)) return [layoutInline(ctx, row)];
  const single = layoutSingle(ctx, row);
  if (single.width <= maxWidth) return [single.row];
  // Find the longest prefix ending at a space that fits.
  const spaces: number[] = [];
  for (let i = 1; i < row.text.length; i++) if (row.text[i] === ' ') spaces.push(i);
  for (let k = spaces.length - 1; k >= 0; k--) {
    const s = spaces[k];
    const head = layoutSingle(ctx, subLine(row, 0, s, true));
    if (head.width <= maxWidth || k === 0) {
      const rest = subLine(row, s + 1, row.text.length, true);
      const indent = ctx.style.wrapIndent * ctx.scale;
      const tail = layoutLine(ctx, rest, maxWidth - indent).map((r) => ({
        ...r,
        items: r.items.map((it) => ({ ...it, x: it.x + indent })),
      }));
      return [head.row, ...tail];
    }
  }
  return [single.row]; // a single word too long to wrap
}

function layoutComment(ctx: Ctx, row: CommentRow): Row {
  const { fonts, style } = ctx;
  const size = sz(ctx, style.comment);
  return {
    height: size * style.lineHeight,
    items: [{ type: 'text', x: 0, y: fonts.ascent(style.comment.font, size), text: row.text, font: style.comment.font, size, role: 'comment', line: row.line }],
  };
}

interface MeasuredBlock {
  rows: Row[];
  height: number;
  breakBefore?: 'column' | 'page';
  wrapped: number;
}

function measureBlock(ctx: Ctx, block: Block, colWidth: number): MeasuredBlock {
  const { style, fonts } = ctx;
  const indent = block.kind === 'chorus' ? style.chorusIndent * ctx.scale : 0;
  const rows: Row[] = [];
  let wrapped = 0;
  for (const r of block.rows) {
    const laid = r.kind === 'comment' ? [layoutComment(ctx, r)] : layoutLine(ctx, r, colWidth - indent);
    wrapped += laid.length - 1;
    rows.push(...laid.map((row) => ({ ...row, items: row.items.map((it) => ({ ...it, x: it.x + indent })) })));
  }
  if (block.label && rows.length) {
    // Print the label to the left of the first lyrics line when it fits in the
    // indent, otherwise on its own row above the paragraph.
    const lsize = sz(ctx, style.label);
    const w = fonts.width(style.label.font, lsize, block.label);
    const first = rows[0];
    const lyric = first.items.find((it) => it.role === 'lyrics' || it.role === 'comment');
    if (lyric && indent && w + 3 <= indent) {
      first.items.push({ type: 'text', x: 0, y: lyric.y, text: block.label, font: style.label.font, size: lsize, role: 'label', line: lyric.line });
    } else {
      rows.unshift({
        height: lsize * style.lineHeight,
        items: [{ type: 'text', x: 0, y: fonts.ascent(style.label.font, lsize), text: block.label, font: style.label.font, size: lsize, role: 'label' }],
      });
    }
  }
  return { rows, height: rows.reduce((h, r) => h + r.height, 0), breakBefore: block.breakBefore, wrapped };
}

// ---------------------------------------------------------------------------
// Page flow

function header(ctx: Ctx, s: SongStructure, x0: number, width: number): { items: TextItem[]; height: number } {
  const { fonts, style } = ctx;
  const items: TextItem[] = [];
  let y = 0;
  const put = (text: string, t: TextStyle, role: TextItem['role']) => {
    const size = sz(ctx, t);
    const w = fonts.width(t.font, size, text);
    const x = style.titleAlign === 'center' ? x0 + (width - w) / 2 : x0;
    items.push({ type: 'text', x, y: y + fonts.ascent(t.font, size), text, font: t.font, size, role });
    y += size * style.lineHeight;
  };
  if (s.title) put(s.title, style.title, 'title');
  if (s.subtitle) put(s.subtitle, style.subtitle, 'subtitle');
  if (y > 0) y += style.headerGap * ctx.scale;
  return { items, height: y };
}

function flow(ctx: Ctx, s: SongStructure, columns: 1 | 2): { pages: LaidPage[]; wrapped: number } {
  const { opts, style } = ctx;
  const m = style.margin;
  const innerW = opts.width - m.left - m.right;
  const colGap = style.columnGap;
  const colW = columns === 1 ? innerW : (innerW - colGap) / 2;
  const blockGap = style.blockGap * ctx.scale;

  const pages: LaidPage[] = [];
  let page: LaidPage;
  let col = 0;
  let y = 0;
  let top = 0;
  let wrapped = 0;
  const bottom = opts.height - m.bottom;

  const newPage = (first: boolean) => {
    page = { width: opts.width, height: opts.height, items: [] };
    pages.push(page);
    top = m.top;
    if (first) {
      const h = header(ctx, s, m.left, innerW);
      page.items.push(...h.items.map((it) => ({ ...it, y: it.y + m.top })));
      top += h.height;
    }
    col = 0;
    y = top;
  };
  const nextColumn = () => {
    if (col + 1 < columns) {
      col++;
      y = top;
    } else newPage(false);
  };
  const colX = () => m.left + col * (colW + colGap);
  const place = (row: Row) => {
    const x = colX();
    for (const it of row.items) page.items.push({ ...it, x: it.x + x, y: it.y + y });
    y += row.height;
  };

  newPage(true);
  for (const block of s.blocks) {
    const mb = measureBlock(ctx, block, colW);
    wrapped += mb.wrapped;
    if (mb.breakBefore === 'page') newPage(false);
    else if (mb.breakBefore === 'column') nextColumn();
    const atTop = y === top;
    const gap = atTop ? 0 : blockGap;
    // Keep paragraphs together: start a new column rather than splitting one.
    if (y + gap + mb.height > bottom && !atTop) nextColumn();
    else y += gap;
    for (const row of mb.rows) {
      if (y + row.height > bottom && y > top) nextColumn();
      place(row);
    }
  }
  return { pages, wrapped };
}

export function layoutSong(doc: SongDoc, fonts: FontRegistry, style: SongStyle, opts: LayoutOptions): SongLayout {
  const s = structure(doc);
  const spelling = spellingForKey(s.key, opts.transpose);
  const colChoices: (1 | 2)[] = opts.columns !== 'auto' ? [opts.columns] : s.columns ? [s.columns] : [1, 2];
  const scales: number[] = [];
  if (opts.scale) scales.push(opts.scale);
  else for (let k = 1; k >= style.minScale - 1e-9; k -= 0.05) scales.push(Math.round(k * 100) / 100);

  let best: { pages: LaidPage[]; scale: number; columns: 1 | 2; wrapped: number } | null = null;
  const better = (a: NonNullable<typeof best>, b: typeof best) => {
    if (!b) return true;
    if (a.pages.length !== b.pages.length) return a.pages.length < b.pages.length;
    // Among layouts with the same page count, trade font size against wrapped
    // lines: each wrap costs as much as shrinking the text by 4%.
    const cost = (c: NonNullable<typeof best>) => (1 - c.scale) * 100 + c.wrapped * 4;
    const ca = cost(a), cb = cost(b);
    if (Math.abs(ca - cb) > 1e-6) return ca < cb;
    return a.columns < b.columns;
  };
  for (const scale of scales) {
    for (const columns of colChoices) {
      const ctx: Ctx = { fonts, style, scale, opts, spelling };
      const r = flow(ctx, s, columns);
      const cand = { ...r, scale, columns };
      if (better(cand, best)) best = cand;
    }
    // Smaller text only helps to save pages or avoid wraps.
    if (best && best.pages.length === 1 && best.wrapped === 0) break;
  }
  return { pages: best!.pages, columns: best!.columns, scale: best!.scale, title: s.title };
}
