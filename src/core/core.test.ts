import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChord, renderChord, spellingForKey } from './chords';
import { parseSong, serializeSong } from './chordpro';
import { FontRegistry, BUNDLED_FONTS } from './fonts';
import { bookletOrder } from './impose';
import { convertNotation, songNotation, transposeSong } from './transform';
import { DEFAULT_STYLE, isInlineChordLine, layoutSong, structure } from './layout';
import { resolveBookPath, songbookFiles } from './songbook';

const it_ = (notation: 'italian' | 'english', transpose = 0) => ({ notation, transpose });

describe('chords', () => {
  it('parses English and Italian names', () => {
    expect(parseChord('F#m7/C#')).toMatchObject({ root: { pc: 6 }, minor: true, suffix: '7', bass: { pc: 1 } });
    expect(parseChord('La-')).toMatchObject({ root: { pc: 9 }, minor: true, suffix: '' });
    expect(parseChord('Mi–')).toMatchObject({ root: { pc: 4 }, minor: true });
    expect(parseChord('SOL')).toMatchObject({ root: { pc: 7 }, minor: false });
    expect(parseChord('Gmaj7/D')).toMatchObject({ root: { pc: 7 }, minor: false, suffix: 'maj7', bass: { pc: 2 } });
    expect(parseChord('Sol 4')).toMatchObject({ root: { pc: 7 }, suffix: ' 4' });
  });

  it('leaves non-chords alone', () => {
    for (const s of ['N.C.', '|', '(2x)', 'Rit.', 'Intro', 'x2']) expect(parseChord(s)).toBeNull();
    expect(renderChord('N.C.', it_('english', 3))).toBe('N.C.');
  });

  it('converts notation', () => {
    expect(renderChord('Am', it_('italian'))).toBe('Lam');
    expect(renderChord('La-', it_('english'))).toBe('Am');
    expect(renderChord('Lam', it_('english'))).toBe('Am');
    expect(renderChord('Mi–7', it_('italian', 2))).toBe('Fa#-7');
    expect(renderChord('Lam', it_('italian', 2))).toBe('Sim');
    expect(renderChord('Rem/Fa', it_('italian', -2))).toBe('Dom/Mib');
    expect(renderChord('Bbmaj7/F', it_('italian'))).toBe('Sibmaj7/Fa');
    expect(renderChord('Re7', it_('english'))).toBe('D7');
  });

  it('transposes', () => {
    expect(renderChord('C', it_('english', 2))).toBe('D');
    expect(renderChord('A', it_('english', -2))).toBe('G');
    expect(renderChord('Do', it_('italian', 1))).toBe('Do#');
    expect(renderChord('E', it_('english', 12))).toBe('E');
    expect(renderChord('F', { notation: 'english', transpose: 5, spelling: spellingForKey('F', 5) })).toBe('Bb');
    // C+1 is written in Db (5 flats) rather than C# (7 sharps).
    expect(renderChord('C', { notation: 'english', transpose: 1, spelling: spellingForKey('C', 1) })).toBe('Db');
    expect(renderChord('F#m', { notation: 'english', transpose: 2, spelling: spellingForKey('D', 2) })).toBe('G#m');
  });
});

describe('chordpro', () => {
  const src = `{title: Test}
{soc}
Hel[C]lo [G7]world
{eoc}

# comment
Intro: [C] [G] (2x)
`;

  it('anchors chords to letters', () => {
    const doc = parseSong(src);
    const l = doc.lines[2];
    expect(l).toEqual({ kind: 'lyrics', text: 'Hello world', chords: [{ pos: 3, chord: 'C' }, { pos: 6, chord: 'G7' }] });
  });

  it('round-trips, normalising directive names', () => {
    const out = serializeSong(parseSong(src));
    expect(out).toContain('{start_of_chorus}');
    expect(serializeSong(parseSong(out))).toBe(out);
    expect(out).toContain('Hel[C]lo [G7]world');
    expect(out).toContain('# comment');
  });

  it('prints only instrumental lines with inline chords', () => {
    const inline = (src: string) => {
      const l = parseSong(src).lines[0];
      return l.kind === 'lyrics' && isInlineChordLine(l.text, l.chords);
    };
    expect(inline('Intro: [C] [G] (2x)')).toBe(true);
    expect(inline('[Do] [Sol] [La-] | [Fa] x2')).toBe(true);
    expect(inline('Strumentale [Re] [La] (ripetere 2 volte)')).toBe(true);
    expect(inline('    [Re]       asdasda')).toBe(false);
    expect(inline('Hel[C]lo world')).toBe(false);
  });

  it('builds paragraphs and chorus references', () => {
    const s = structure(parseSong('{soc}\nA [C]b\n{eoc}\n\nverse\n\n{chorus}\n'));
    expect(s.blocks.map((b) => b.kind)).toEqual(['chorus', 'plain', 'chorus']);
    expect(s.blocks[2].rows[0]).toMatchObject({ text: 'A b…' });
  });
});

describe('imposition', () => {
  it('orders pages for saddle stitching', () => {
    expect(bookletOrder(8)).toEqual([[7, 0], [1, 6], [5, 2], [3, 4]]);
    expect(bookletOrder(3)).toEqual([[3, 0], [1, 2]]);
  });
});

describe('layout', () => {
  const fonts = new FontRegistry();
  for (const id of BUNDLED_FONTS) fonts.add(id, new Uint8Array(readFileSync(join(__dirname, '../../public/fonts', id + '.ttf'))));
  const opts = { width: 419.53, height: 595.28, columns: 'auto' as const, notation: 'italian' as const, transpose: 0, showChords: true };

  it('places chords above their letter', () => {
    const r = layoutSong(parseSong('{title: T}\nHel[C]lo'), fonts, DEFAULT_STYLE, opts);
    const items = r.pages[0].items;
    const chord = items.find((i) => i.type === 'text' && i.role === 'chord')!;
    const lo = items.find((i) => i.type === 'text' && i.role === 'lyrics' && i.text === 'lo')!;
    expect(chord.type === 'text' && chord.text).toBe('Do');
    expect(chord.type === 'text' && lo.type === 'text' && chord.x).toBeCloseTo(lo.type === 'text' ? lo.x : 0);
  });

  it('switches to two columns and shrinks rather than overflowing', () => {
    const verse = '[C]Lorem ipsum dolor [G]sit amet\n'.repeat(4);
    const long = Array.from({ length: 9 }, () => verse).join('\n');
    const r = layoutSong(parseSong(`{title: Long}\n${long}`), fonts, DEFAULT_STYLE, opts);
    expect(r.pages.length).toBe(1);
    expect(r.columns).toBe(2);
  });

  it('lays out a typical song on one page', () => {
    // Amazing Grace (John Newton, 1779): public domain.
    const verses = [
      'A[G]mazing grace, how [C]sweet the [G]sound\nThat saved a wretch like [D]me\nI [G]once was lost, but [C]now am [G]found\nWas blind, but [D]now I [G]see',
      "'Twas [G]grace that taught my [C]heart to [G]fear\nAnd grace my fears re[D]lieved\nHow [G]precious did that [C]grace ap[G]pear\nThe hour I [D]first be[G]lieved",
      'Through [G]many dangers, [C]toils and [G]snares\nI have already [D]come\n\'Tis [G]grace hath brought me [C]safe thus [G]far\nAnd grace will [D]lead me [G]home',
      'The [G]Lord has promised [C]good to [G]me\nHis word my hope se[D]cures\nHe [G]will my shield and [C]portion [G]be\nAs long as [D]life en[G]dures',
      'When [G]we\'ve been there ten [C]thousand [G]years\nBright shining as the [D]sun\nWe\'ve [G]no less days to [C]sing God\'s [G]praise\nThan when we\'d [D]first be[G]gun',
    ];
    const doc = parseSong(`{title: Amazing Grace}\n{artist: John Newton}\n\n${verses.join('\n\n')}\n`);
    expect(layoutSong(doc, fonts, DEFAULT_STYLE, opts).pages.length).toBe(1);
  });
});

describe('song transforms', () => {
  const src = '{title: T}\n{key: D}\n[D]Siamo [Bm]aquile [N.C.]ran[F#7]dagie\n';

  it('transposes chords and key in the song itself', () => {
    const out = serializeSong(transposeSong(parseSong(src), 1));
    expect(out).toContain('{key: Eb}');
    expect(out).toContain('[Eb]Siamo [Cm]aquile [N.C.]ran[G7]dagie');
  });

  it('converts notation, keeping unparsed chords', () => {
    const out = serializeSong(convertNotation(parseSong(src), 'italian'));
    expect(out).toContain('{key: Re}');
    expect(out).toContain('[Re]Siamo [Sim]aquile [N.C.]ran[Fa#7]dagie');
    expect(songNotation(parseSong(out))).toBe('italian');
  });

  it('prints chords as written by default', () => {
    expect(renderChord('LA-', { notation: 'original', transpose: 0 })).toBe('LA-');
    expect(renderChord('La-', { notation: 'original', transpose: 2 })).toBe('Si-');
  });
});

describe('songbook files', () => {
  it('lists the files a songbook uses, and the ones missing', async () => {
    const ws: Record<string, string> = {
      'book.songbook.yaml': 'title: B\ncontents:\n  - page: pages/cover.page.yaml\n  - song: songs/a.cho\n  - song: songs/gone.cho\n  - image: images/full.jpg\n  - blank\n',
      'pages/cover.page.yaml': 'elements:\n  - text: Hi\n    font: Fancy-Regular\n  - image: images/logo.png\n',
      'songs/a.cho': '{title: A}',
      'songs/other.cho': '{title: Other}',
      'images/logo.png': '',
      'images/full.jpg': '',
      'images/unused.png': '',
      'fonts/Fancy-Regular.ttf': '',
      'fonts/Unused-Regular.ttf': '',
    };
    const r = await songbookFiles('book.songbook.yaml', Object.keys(ws), async (p) => ws[p]);
    expect(r.files.sort()).toEqual(['book.songbook.yaml', 'fonts/Fancy-Regular.ttf', 'images/full.jpg', 'images/logo.png', 'pages/cover.page.yaml', 'songs/a.cho']);
    expect(r.missing).toEqual(['songs/gone.cho']);
  });

  it('resolves paths relative to the songbook', () => {
    expect(resolveBookPath('books/x.songbook.yaml', '../songs/a.cho')).toBe('songs/a.cho');
    expect(resolveBookPath('books/x.songbook.yaml', 'local.cho')).toBe('books/local.cho');
  });
});
