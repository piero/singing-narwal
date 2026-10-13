// ChordPro reader/writer.
//
// Songs are stored as ChordPro text (https://www.chordpro.org/), a plain-text
// format where chords are written inline, right before the letter they belong to:
//
//   {title: Matilda Mother}
//   There [Bsus4]was a king who [Asus2]ruled the land.
//
// This keeps each chord anchored to its letter: editing the lyrics with any text
// editor moves the chords along with the text.
//
// The document model keeps one entry per source line, so a file can be read and
// written back without losing comments, ordering or unknown directives.

export interface ChordAnchor {
  /** Index in the line text of the character the chord is attached to. */
  pos: number;
  chord: string;
}

export type SongLine =
  | { kind: 'lyrics'; text: string; chords: ChordAnchor[] }
  | { kind: 'directive'; name: string; value: string }
  | { kind: 'empty' }
  | { kind: 'comment'; text: string };

export interface SongDoc {
  lines: SongLine[];
}

// Short directive names, normalised to their long form.
const ALIASES: Record<string, string> = {
  t: 'title',
  st: 'subtitle',
  c: 'comment',
  ci: 'comment_italic',
  cb: 'comment_box',
  soc: 'start_of_chorus',
  eoc: 'end_of_chorus',
  sov: 'start_of_verse',
  eov: 'end_of_verse',
  sob: 'start_of_bridge',
  eob: 'end_of_bridge',
  sot: 'start_of_tab',
  eot: 'end_of_tab',
  colb: 'column_break',
  np: 'new_page',
  npp: 'new_physical_page',
  col: 'columns',
};

export function normalizeDirective(name: string): string {
  const n = name.trim().toLowerCase();
  return ALIASES[n] ?? n;
}

export function parseLyricsLine(src: string): { text: string; chords: ChordAnchor[] } {
  let text = '';
  const chords: ChordAnchor[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && (src[i + 1] === '[' || src[i + 1] === ']')) {
      text += src[i + 1];
      i += 2;
    } else if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end < 0) {
        text += src.slice(i);
        break;
      }
      chords.push({ pos: text.length, chord: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      text += ch;
      i++;
    }
  }
  return { text, chords };
}

const DIRECTIVE_RE = /^\s*\{\s*([A-Za-z_][\w-]*)\s*(?:[:\s]\s*(.*?))?\s*\}\s*$/;

export function parseSong(src: string): SongDoc {
  const lines: SongLine[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') {
      lines.push({ kind: 'empty' });
      continue;
    }
    if (raw.startsWith('#')) {
      lines.push({ kind: 'comment', text: raw.slice(1) });
      continue;
    }
    const d = DIRECTIVE_RE.exec(raw);
    if (d) {
      lines.push({ kind: 'directive', name: normalizeDirective(d[1]), value: d[2] ?? '' });
      continue;
    }
    lines.push({ kind: 'lyrics', ...parseLyricsLine(raw) });
  }
  // Drop trailing empty lines produced by the final newline.
  while (lines.length && lines[lines.length - 1].kind === 'empty') lines.pop();
  return { lines };
}

function escapeText(s: string): string {
  return s.replace(/[[\]]/g, (m) => '\\' + m);
}

export function serializeLyricsLine(text: string, chords: ChordAnchor[]): string {
  const sorted = [...chords].sort((a, b) => a.pos - b.pos);
  let out = '';
  let last = 0;
  for (const c of sorted) {
    const pos = Math.min(Math.max(c.pos, 0), text.length);
    out += escapeText(text.slice(last, pos)) + '[' + c.chord + ']';
    last = pos;
  }
  return out + escapeText(text.slice(last));
}

export function serializeLine(l: SongLine): string {
  switch (l.kind) {
    case 'empty':
      return '';
    case 'comment':
      return '#' + l.text;
    case 'directive':
      return l.value ? `{${l.name}: ${l.value}}` : `{${l.name}}`;
    case 'lyrics':
      return serializeLyricsLine(l.text, l.chords);
  }
}

export function serializeSong(doc: SongDoc): string {
  return doc.lines.map(serializeLine).join('\n') + '\n';
}

/** First value of a directive, e.g. getMeta(doc, 'title'). */
export function getMeta(doc: SongDoc, name: string): string | undefined {
  for (const l of doc.lines) if (l.kind === 'directive' && l.name === name) return l.value;
  return undefined;
}

/** Set (or remove, with an empty value) a metadata directive, keeping it near the top. */
export function setMeta(doc: SongDoc, name: string, value: string): SongDoc {
  const lines = [...doc.lines];
  const idx = lines.findIndex((l) => l.kind === 'directive' && l.name === name);
  if (idx >= 0) {
    if (value) lines[idx] = { kind: 'directive', name, value };
    else lines.splice(idx, 1);
  } else if (value) {
    // Insert after the existing leading metadata block.
    let at = 0;
    while (at < lines.length && (lines[at].kind === 'directive' || lines[at].kind === 'comment')) {
      const l = lines[at];
      if (l.kind === 'directive' && /^(start_of|end_of)/.test(l.name)) break;
      at++;
    }
    lines.splice(at, 0, { kind: 'directive', name, value });
  }
  return { lines };
}
