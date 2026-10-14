// Chord model: parsing (English and Italian names), transposition and rendering.
//
// A chord is stored as written in the source file. Converting notation and
// transposing are edits of the song (see transform.ts); a songbook may also ask to
// print all chords in one notation. Chords that cannot be parsed (e.g. "N.C.",
// "|", "(2x)") are always kept verbatim.

export type Notation = 'english' | 'italian';

export interface Note {
  /** Pitch class, 0 = C. */
  pc: number;
  /** Letter index 0..6 = C D E F G A B, used to keep the original spelling. */
  letter: number;
  /** -1 flat, 0 natural, +1 sharp. */
  accidental: number;
}

export interface Chord {
  root: Note;
  minor: boolean;
  /** Everything after the root and the minor marker, e.g. "7", "maj7", "sus4", "(addB)". */
  suffix: string;
  bass?: Note;
}

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ENGLISH = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ITALIAN = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si'];

// Italian names first: "Do" must not be read as "D" + "o", and "Sol" before "Si".
const NOTE_RE = /^(Do|Re|Mi|Fa|Sol|La|Si|[A-G])(#|♯|b|♭)?/i;

function parseNote(s: string): { note: Note; rest: string } | null {
  const m = NOTE_RE.exec(s);
  if (!m) return null;
  const name = m[1];
  let letter: number;
  if (name.length === 1) {
    // Single letters are English names; must be upper case to avoid matching
    // words such as "b" or "a".
    if (name !== name.toUpperCase()) return null;
    letter = ENGLISH.indexOf(name);
  } else {
    const norm = name[0].toUpperCase() + name.slice(1).toLowerCase();
    letter = ITALIAN.indexOf(norm);
    if (letter < 0) return null;
  }
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const pc = (LETTER_PC[letter] + accidental + 12) % 12;
  return { note: { pc, letter, accidental }, rest: s.slice(m[0].length) };
}

const MINOR_RE = /^(m(?!aj)|min|-|–|−)/;

export function parseChord(text: string): Chord | null {
  const s = text.trim();
  const head = parseNote(s);
  if (!head) return null;
  let rest = head.rest;
  let minor = false;
  const mm = MINOR_RE.exec(rest);
  if (mm) {
    minor = true;
    rest = rest.slice(mm[0].length);
  }
  let bass: Note | undefined;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const b = parseNote(rest.slice(slash + 1));
    if (b && b.rest.trim() === '') {
      bass = b.note;
      rest = rest.slice(0, slash);
    }
  }
  // Reject things that merely start with a note name, e.g. "Rit." or "Intro".
  if (/^[a-z]{2,}/i.test(rest) && !/^(maj|min|sus|add|dim|aug|m)/i.test(rest)) return null;
  return { root: head.note, minor, suffix: rest, bass };
}

// Spelling used when transposing: which accidental to prefer for each pitch class.
const SHARP_SPELLING: [number, number][] = [
  [0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0],
];
const FLAT_SPELLING: [number, number][] = [
  [0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0],
];
// Neutral default: the most common spelling of each black key in guitar songbooks.
const MIXED_SPELLING: [number, number][] = [
  [0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0],
];

export type Spelling = 'sharp' | 'flat' | 'auto';

function transposeNote(n: Note, semitones: number, spelling: Spelling): Note {
  if (semitones % 12 === 0) return n;
  const pc = (((n.pc + semitones) % 12) + 12) % 12;
  const table = spelling === 'sharp' ? SHARP_SPELLING : spelling === 'flat' ? FLAT_SPELLING : MIXED_SPELLING;
  const [letter, accidental] = table[pc];
  return { pc, letter, accidental };
}

export function transposeChord(c: Chord, semitones: number, spelling: Spelling = 'auto'): Chord {
  return {
    ...c,
    root: transposeNote(c.root, semitones, spelling),
    bass: c.bass && transposeNote(c.bass, semitones, spelling),
  };
}

export function noteName(n: Note, notation: Notation): string {
  const base = notation === 'italian' ? ITALIAN[n.letter] : ENGLISH[n.letter];
  return base + (n.accidental > 0 ? '#' : n.accidental < 0 ? 'b' : '');
}

export function formatChord(c: Chord, notation: Notation): string {
  const minor = c.minor ? (notation === 'italian' ? '-' : 'm') : '';
  const bass = c.bass ? '/' + noteName(c.bass, notation) : '';
  return noteName(c.root, notation) + minor + c.suffix + bass;
}

/** Notation a chord is written in ("La-" → italian, "Am" → english). */
export function chordNotation(text: string): Notation {
  return /^\s*(do|re|mi|fa|sol|la|si)/i.test(text) ? 'italian' : 'english';
}

export interface ChordRenderOptions {
  /** Target notation; 'original' keeps each chord's own notation. */
  notation: Notation | 'original';
  transpose: number;
  spelling?: Spelling;
}

/** A chord in the requested notation and key. With no change requested, the text is kept as is. */
export function renderChord(text: string, opts: ChordRenderOptions): string {
  if (opts.notation === 'original' && opts.transpose % 12 === 0) return text;
  const c = parseChord(text);
  if (!c) return text;
  const notation = opts.notation === 'original' ? chordNotation(text) : opts.notation;
  return formatChord(transposeChord(c, opts.transpose, opts.spelling ?? 'auto'), notation);
}

const FLAT_KEYS_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_KEYS_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

/** Pick an accidental spelling for a song in the given key, after transposition. */
export function spellingForKey(key: string | undefined, transpose: number): Spelling {
  if (!key) return 'auto';
  const c = parseChord(key);
  if (!c) return 'auto';
  const pc = (((c.root.pc + transpose) % 12) + 12) % 12;
  return (c.minor ? FLAT_KEYS_MINOR : FLAT_KEYS_MAJOR).has(pc) ? 'flat' : 'sharp';
}
