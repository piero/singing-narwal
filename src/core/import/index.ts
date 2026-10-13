// Song import: .odt documents and plain text (chords over lyrics), or ChordPro
// files that are passed through unchanged.

import type { FontRegistry } from '../fonts';
import { getMeta, parseSong } from '../chordpro';
import { readOdt } from './odt';
import { convertSheet, type SheetLine } from './sheet';

export const IMPORTABLE = /\.(odt|txt|text|cho|chordpro|chopro|crd|pro)$/i;

/** Plain text: monospaced columns, tabs every 8 characters. */
export function readText(text: string): SheetLine[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      let col = 0;
      const chars = [];
      for (const ch of raw.trimEnd()) {
        if (ch === '\t') {
          const next = (Math.floor(col / 8) + 1) * 8;
          chars.push({ ch: ' ', x0: col, x1: next });
          col = next;
        } else {
          chars.push({ ch, x0: col, x1: col + 1 });
          col++;
        }
      }
      return { chars, indent: 0 };
    });
}

/** Text already in ChordPro format: has directives or inline [chords]. */
export function looksLikeChordPro(text: string): boolean {
  return /^\s*\{[a-z_]+(:.*)?\}\s*$/im.test(text) || /\[[A-G](#|b)?[^\]\s]{0,8}\][a-zà-ù]/i.test(text);
}

export interface ImportedSong {
  title: string;
  chordpro: string;
}

function titleFromFileName(name: string): string {
  return name
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\((accordi|chords|testo|lyrics)\)\s*$/i, '')
    .trim();
}

export function importText(text: string, name = 'Untitled'): ImportedSong {
  const fallbackTitle = titleFromFileName(name);
  const chordpro = looksLikeChordPro(text) ? text : convertSheet(readText(text), { fallbackTitle, indentStep: 2 });
  return { title: getMeta(parseSong(chordpro), 'title') || fallbackTitle, chordpro };
}

export function importFile(name: string, bytes: Uint8Array, fonts: FontRegistry): ImportedSong {
  if (/\.odt$/i.test(name)) {
    const fallbackTitle = titleFromFileName(name);
    const chordpro = convertSheet(readOdt(bytes, fonts), { fallbackTitle, indentStep: 20 });
    return { title: getMeta(parseSong(chordpro), 'title') || fallbackTitle, chordpro };
  }
  return importText(new TextDecoder().decode(bytes), name);
}

/** File name for a song title: lower case, no accents, dashes. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'song'
  );
}
