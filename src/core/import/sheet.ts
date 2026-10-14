// Conversion of "chords over lyrics" sheets to ChordPro.
//
// Most songbooks are written with a line of chords above each line of lyrics,
// aligned with spaces:
//
//        Do          Fa
//   Sento nel profondo un desiderio
//
// Readers (plain text, OpenDocument) turn their input into SheetLines where
// every character has a horizontal position. The converter then attaches each
// chord to the lyric character found underneath it. With proportional fonts the
// positions come from the real font metrics, not from counting spaces.

import { chordNotation, formatChord, parseChord } from '../chords';

export interface SheetChar {
  ch: string;
  /** Left and right edge, in any unit (points for documents, columns for text). */
  x0: number;
  x1: number;
}

export interface SheetLine {
  chars: SheetChar[];
  /** Left edge of the paragraph (after indentation). */
  indent: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  size?: number;
  bold?: boolean;
  italic?: boolean;
  heading?: boolean;
}

export interface ConvertOptions {
  /** Title to use when none is detected (e.g. the file name). */
  fallbackTitle?: string;
  /** Width of one indentation step, used to detect indented choruses. */
  indentStep: number;
}

const lineText = (l: SheetLine) => l.chars.map((c) => c.ch).join('');

// Tokens allowed on a chord line besides chords.
const CHORD_LINE_EXTRA = /^(\||\|\||\/|-|–|%|\.\.\.|…|\(?(x|×)?\d+(x|×|v\.?|volte)?\)?|N\.?C\.?|\(|\)|:|\*|rit\.?|bis)$/i;

interface Token {
  text: string;
  /** Index of the first character in the line. */
  start: number;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push({ text: m[0], start: m.index! });
  return out;
}

/** Strip brackets around a chord, e.g. "(Mi7)" → "Mi7". */
function bare(t: string): string {
  return t.replace(/^\(|\)$/g, '');
}

function isChordToken(t: string): boolean {
  return parseChord(bare(t)) !== null;
}

/**
 * Classify a line: a chord line has only chords and musical symbols. Returns
 * the index of the first token after a leading label ("Intro:", "Rit.:"), or -1.
 */
function chordLineStart(text: string): number {
  const toks = tokens(text);
  if (!toks.length) return -1;
  let start = 0;
  // Optional label: words ending with ":" before the chords.
  const label = toks.findIndex((t) => t.text.endsWith(':'));
  if (label >= 0 && label < 3 && toks.slice(0, label + 1).every((t) => !isChordToken(t.text))) start = label + 1;
  const rest = toks.slice(start);
  if (!rest.length) return -1;
  let chords = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (isChordToken(t) || /^N\.?C\.?$/i.test(t)) chords++;
    else if (/^\d+$/.test(t) && i > 0 && isChordToken(rest[i - 1].text)) continue; // "Sol 4"
    else if (!CHORD_LINE_EXTRA.test(t)) return -1;
  }
  return chords > 0 ? start : -1;
}

/** Chords of a chord line with their x positions, merging "Sol 4"-style suffixes. */
function chordsOf(line: SheetLine, from: number): { chord: string; x: number }[] {
  const text = lineText(line);
  const toks = tokens(text).slice(from);
  const out: { chord: string; x: number }[] = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(t.text) && prev && isChordToken(prev.chord) && !CHORD_LINE_EXTRA.test(t.text)) {
      prev.chord += ' ' + t.text;
      continue;
    }
    out.push({ chord: t.text, x: line.chars[t.start].x0 });
  }
  return out;
}

/** Normalise the spelling of a chord, keeping its notation (e.g. "SIm" → "Si-"). */
export function normalizeChord(c: string): string {
  const p = parseChord(c);
  return p ? formatChord(p, chordNotation(c)) : c;
}

/** Index of the lyric character under position x (may be past the end). */
function charIndexAt(line: SheetLine, x: number, spaceWidth: number): number {
  const cs = line.chars;
  for (let i = 0; i < cs.length; i++) {
    // A chord belongs to the character it starts over; allow a little slack to the left.
    if (x < cs[i].x1 - Math.min(spaceWidth, (cs[i].x1 - cs[i].x0) / 2)) return i;
  }
  const end = cs.length ? cs[cs.length - 1].x1 : line.indent;
  return cs.length + Math.max(0, Math.round((x - end) / spaceWidth));
}

function escapeLyrics(s: string) {
  return s.replace(/[[\]]/g, (m) => '\\' + m);
}

function mergeChordLine(chordLine: SheetLine, from: number, lyric: SheetLine, spaceWidth: number): string {
  let text = lineText(lyric);
  let anchors = chordsOf(chordLine, from).map((c) => ({ chord: c.chord, pos: charIndexAt(lyric, c.x, spaceWidth) }));
  // A chord above a space belongs to the word after it.
  const lastChar = text.trimEnd().length;
  for (const a of anchors) while (a.pos < lastChar && text[a.pos] === ' ') a.pos++;
  // Spaces typed only to make room for chords are not needed: the layout
  // engine spaces out chords that would collide.
  const collapsed = collapseSpaces(text.slice(0, lastChar), anchors);
  text = collapsed.text + text.slice(lastChar);
  anchors = collapsed.anchors;
  // Chords after the end of the lyrics: one space apart.
  const end = collapsed.text.length;
  text = collapsed.text;
  anchors
    .filter((a) => a.pos >= end)
    .sort((p, q) => p.pos - q.pos)
    .forEach((a, k) => (a.pos = end + 1 + k));
  const maxPos = Math.max(0, ...anchors.map((a) => a.pos));
  if (maxPos > text.length) text += ' '.repeat(maxPos - text.length);
  // Two chords on the same letter: keep both, in order.
  let out = '';
  let last = 0;
  for (const a of anchors.sort((p, q) => p.pos - q.pos)) {
    out += escapeLyrics(text.slice(last, a.pos)) + `[${bracketChord(a.chord)}]`;
    last = a.pos;
  }
  return (out + escapeLyrics(text.slice(last))).trimEnd();
}

function collapseSpaces(text: string, anchors: { chord: string; pos: number }[]) {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length;
    if (text[i] === ' ' && (out.endsWith(' ') || out === '')) continue;
    out += text[i];
  }
  map[text.length] = out.length;
  const shift = text.length - out.length;
  return {
    text: out,
    anchors: anchors.map((a) => ({ ...a, pos: a.pos <= text.length ? map[a.pos] : a.pos - shift })),
  };
}

function bracketChord(t: string): string {
  return isChordToken(t) ? normalizeChord(bare(t)) : t;
}

/** A chord line with nothing under it: "Intro: [Do] [Fa] (2x)". */
function inlineChordLine(line: SheetLine, from: number): string {
  const text = lineText(line);
  const toks = tokens(text);
  const label = toks.slice(0, from).map((t) => t.text).join(' ');
  const parts = chordsOf(line, from).map((c) => (isChordToken(c.chord) ? `[${normalizeChord(bare(c.chord))}]` : c.chord));
  return (label ? label + ' ' : '') + parts.join(' ');
}

export function convertSheet(lines: SheetLine[], opts: ConvertOptions): string {
  // Drop leading/trailing blank lines.
  const isBlank = (l: SheetLine) => lineText(l).trim() === '';
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a])) a++;
  while (b > a && isBlank(lines[b - 1])) b--;
  lines = lines.slice(a, b);

  // Header: a title (heading, centred, bold or large first line) and an artist line.
  const header: string[] = [];
  let i = 0;
  const bodySize = median(lines.filter((l) => !isBlank(l)).map((l) => l.size ?? 0));
  const styled = lines.some((l) => l.size !== undefined);
  const looksLikeHeader = (l: SheetLine, k: number) =>
    !isBlank(l) &&
    chordLineStart(lineText(l)) < 0 &&
    (l.heading ||
      l.align === 'center' ||
      (l.size ?? 0) > bodySize + 0.5 ||
      /^#\s/.test(lineText(l)) ||
      // Plain text: a short first line followed by a blank line.
      (!styled && lineText(l).trim().length < 60 && (lines[k + 1] === undefined || isBlank(lines[k + 1]))));
  const clean = (l: SheetLine) => {
    const t = lineText(l).replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    // ALL-CAPS titles become sentence case: "IL CANTO" → "Il canto".
    return /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t) ? t[0] + t.slice(1).toLowerCase() : t;
  };
  if (lines.length && looksLikeHeader(lines[0], 0)) {
    header.push(`{title: ${clean(lines[0])}}`);
    i = 1;
    while (i < lines.length && isBlank(lines[i])) i++;
    const l = lines[i];
    if (l && looksLikeHeaderOrItalic(l) && (l.italic || l.align === 'center' || /^##\s/.test(lineText(l)))) {
      header.push(`{artist: ${clean(l)}}`);
      i++;
    }
  } else if (opts.fallbackTitle) header.push(`{title: ${opts.fallbackTitle}}`);

  function looksLikeHeaderOrItalic(l: SheetLine) {
    return chordLineStart(lineText(l)) < 0 && lineText(l).trim().length < 60;
  }

  // Body: pair chord lines with the lyric line below them.
  type Out = { text: string; indent: number; blank: boolean };
  const out: Out[] = [];
  const space = (l: SheetLine) => {
    const s = l.chars.find((c) => c.ch === ' ');
    return s ? s.x1 - s.x0 : opts.indentStep / 4;
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) {
      out.push({ text: '', indent: 0, blank: true });
      continue;
    }
    const text = lineText(l);
    const from = chordLineStart(text);
    const firstX = l.chars.find((c) => c.ch.trim())?.x0 ?? l.indent;
    if (from >= 0) {
      const next = lines[i + 1];
      if (next && !isBlank(next) && chordLineStart(lineText(next)) < 0 && from === 0) {
        const nextFirst = next.chars.find((c) => c.ch.trim())?.x0 ?? next.indent;
        out.push({ text: mergeChordLine(l, from, next, space(next)), indent: nextFirst, blank: false });
        i++;
      } else {
        out.push({ text: inlineChordLine(l, from), indent: firstX, blank: false });
      }
    } else {
      out.push({ text: escapeLyrics(text.trimEnd()), indent: firstX, blank: false });
    }
  }

  // Paragraphs indented relative to the rest are choruses.
  const paragraphs: Out[][] = [];
  for (const o of out) {
    if (o.blank) {
      if (paragraphs.length && paragraphs[paragraphs.length - 1].length) paragraphs.push([]);
    } else {
      if (!paragraphs.length) paragraphs.push([]);
      paragraphs[paragraphs.length - 1].push({ ...o, text: o.text.replace(/^\s+/, '') });
    }
  }
  const nonEmpty = paragraphs.filter((p) => p.length);
  const baseIndent = Math.min(...nonEmpty.map((p) => Math.min(...p.map((o) => o.indent))));
  const isIndented = (p: Out[]) => p.every((o) => o.indent - baseIndent >= opts.indentStep * 0.6);

  const body: string[] = [];
  const choruses: string[] = [];
  for (const p of nonEmpty) {
    if (body.length) body.push('');
    const plain = p.map((o) => o.text.replace(/\[[^\]]*\]/g, '').trim());
    // "È giunta l'ora…" alone and indented: a reference to the chorus.
    if (p.length === 1 && /(\.\.\.|…)$/.test(plain[0])) {
      const stem = plain[0].replace(/(\.\.\.|…)$/, '').trim().toLowerCase();
      if (choruses.some((c) => c.startsWith(stem))) {
        body.push('{chorus}');
        continue;
      }
    }
    // "Rit." alone repeats the chorus; "Rit.: lyrics" starts a labelled chorus.
    if (p.length === 1 && RIT_RE.test(plain[0]) && plain[0].replace(RIT_RE, '').trim() === '') {
      body.push('{chorus}');
      continue;
    }
    const rit = RIT_RE.exec(p[0].text);
    if (rit) {
      const first = { ...p[0], text: p[0].text.slice(rit[0].length) };
      body.push(`{start_of_chorus: ${rit[1]}}`, first.text, ...p.slice(1).map((o) => o.text), '{end_of_chorus}');
      choruses.push(plain.join(' ').replace(RIT_RE, '').toLowerCase());
      continue;
    }
    if (isIndented(p)) {
      body.push('{start_of_chorus}', ...p.map((o) => o.text), '{end_of_chorus}');
      choruses.push(plain.join(' ').toLowerCase());
    } else body.push(...p.map((o) => o.text));
  }
  return [...header, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// A chorus label: "Rit.:", "Chorus:", or the word alone on the line.
const RIT_RE = /^\s*((?:Rit|Ritornello|Chorus|Coro|Refrain)\.?)\s*(?::|$)\s*/i;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}
