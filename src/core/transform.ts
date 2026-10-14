// Song-wide chord edits: transposing and converting between notations.
// These change the song itself (what the editor shows and what is saved).

import { getMeta, setMeta, type SongDoc } from './chordpro';
import { chordNotation, parseChord, renderChord, spellingForKey, type Notation } from './chords';

function mapChords(doc: SongDoc, fn: (chord: string) => string): SongDoc {
  return {
    lines: doc.lines.map((l) => (l.kind === 'lyrics' && l.chords.length ? { ...l, chords: l.chords.map((c) => ({ ...c, chord: fn(c.chord) })) } : l)),
  };
}

/** Transpose all chords (and the key) by a number of semitones. */
export function transposeSong(doc: SongDoc, semitones: number): SongDoc {
  if (semitones % 12 === 0) return doc;
  const key = getMeta(doc, 'key');
  const spelling = spellingForKey(key, semitones);
  const opts = { notation: 'original' as const, transpose: semitones, spelling };
  let out = mapChords(doc, (c) => renderChord(c, opts));
  if (key && parseChord(key)) out = setMeta(out, 'key', renderChord(key, opts));
  return out;
}

/** Rewrite all chords (and the key) in the given notation. */
export function convertNotation(doc: SongDoc, notation: Notation): SongDoc {
  const opts = { notation, transpose: 0 };
  let out = mapChords(doc, (c) => renderChord(c, opts));
  const key = getMeta(doc, 'key');
  if (key && parseChord(key)) out = setMeta(out, 'key', renderChord(key, opts));
  return out;
}

/** Notation used by most chords of the song, or null if it has no chords. */
export function songNotation(doc: SongDoc): Notation | null {
  let it = 0;
  let en = 0;
  for (const l of doc.lines) {
    if (l.kind !== 'lyrics') continue;
    for (const c of l.chords) {
      if (!parseChord(c.chord)) continue;
      if (chordNotation(c.chord) === 'italian') it++;
      else en++;
    }
  }
  return it + en === 0 ? null : it >= en ? 'italian' : 'english';
}
