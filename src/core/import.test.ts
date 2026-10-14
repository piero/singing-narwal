import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, FontRegistry } from './fonts';
import { importFile, importText } from './import';
import { toPt } from './import/odt';
import { layoutPage, starterTemplate } from './pages';

const fonts = new FontRegistry();
for (const id of BUNDLED_FONTS) fonts.add(id, new Uint8Array(readFileSync(join(__dirname, '../../public/fonts', id + '.ttf'))));

describe('text import', () => {
  it('attaches chords to the letters below them', () => {
    const song = importText(
      `# Matilda Mother

## Pink Floyd

      Bsus4 Asus2    G6        F#7sus4
There was a king who ruled the land.

Intro: B  A/B  Gmaj7/D

N.C.
Why'd you have to leave me there,
`,
      'matilda.txt',
    );
    expect(song.chordpro).toContain('There [Bsus4]was a [Asus2]king who [G6]ruled the [F#7sus4]land.');
    expect(song.chordpro).toContain('Intro: [B] [A/B] [Gmaj7/D]');
    expect(song.chordpro).toContain("[N.C.]Why'd you have to leave me there,");
    expect(song.title).toBe('Matilda Mother');
    expect(song.chordpro).toContain('{artist: Pink Floyd}');
  });

  it('detects indented choruses and chorus references', () => {
    const song = importText(
      `C       G
Verse line one

    F      C
    Chorus line here

    Chorus line here...
`,
      'x.txt',
    );
    expect(song.chordpro).toContain('{start_of_chorus}\n[F]Chorus [C]line here\n{end_of_chorus}');
    expect(song.chordpro).toMatch(/\{chorus\}/);
  });

  it('passes ChordPro through', () => {
    expect(importText('{title: X}\n[C]Hello', 'x.txt').chordpro).toBe('{title: X}\n[C]Hello');
  });

  it('normalises chord spelling', () => {
    expect(importText('SIm  LA\nCiao bella', 'x.txt').chordpro).toContain('[Sim]Ciao [La]bella');
    expect(importText('LA-  RE\nCiao bella', 'x.txt').chordpro).toContain('[La-]Ciao [Re]bella');
  });
});

describe('odt import', () => {
  const odt = (body: string) =>
    zipSync({
      'content.xml': strToU8(`<?xml version="1.0"?><office:document-content><office:automatic-styles>
        <style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
        <style:style style:name="B" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
        <style:style style:name="Ind" style:family="paragraph"><style:paragraph-properties fo:text-indent="1cm"/></style:style>
        </office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`),
    });

  it('reads styles, spaces and indents', () => {
    const song = importFile(
      'test.odt',
      odt(`<text:p text:style-name="P1">My Song</text:p><text:p/>
        <text:p text:style-name="B">DO<text:s text:c="22"/>SOL</text:p><text:p>Sento nel profondo un desiderio</text:p>
        <text:p/>
        <text:p text:style-name="Ind">LA-</text:p><text:p text:style-name="Ind">Estote parati</text:p>`),
      fonts,
    );
    expect(song.title).toBe('My Song');
    expect(song.chordpro).toMatch(/\[Do\]Sento nel pro\S*\[Sol\]/);
    expect(song.chordpro).toContain('{start_of_chorus}\n[La-]Estote parati\n{end_of_chorus}');
  });

  it('converts lengths', () => {
    expect(toPt('2.54cm')).toBeCloseTo(72);
    expect(toPt('0.5in')).toBe(36);
    expect(toPt('10pt')).toBe(10);
  });
});

describe('page templates', () => {
  it('fills the free space and replaces placeholders', () => {
    const page = layoutPage(starterTemplate('cover', 'it'), {
      fonts,
      width: 420,
      height: 595,
      defaultMargin: 28,
      defaultFont: 'LiberationSerif-Regular',
      vars: { title: 'Canzoniere' },
      imageSizes: {},
    });
    const title = page.items.find((i) => i.type === 'text' && i.text === 'Canzoniere');
    const box = page.items.find((i) => i.type === 'rect');
    expect(title).toBeTruthy();
    expect(box && box.type === 'rect' && box.y + box.height).toBeCloseTo(595 - 28);
  });
});
