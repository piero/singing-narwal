import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, FontRegistry } from './fonts';
import { importFile, importText } from './import';
import { importOdg } from './import/odg';
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

describe('odg songbook import', () => {
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const frame = (x: number, y: number, w: number, h: number, inner: string) =>
    `<draw:frame svg:x="${x}cm" svg:y="${y}cm" svg:width="${w}cm" svg:height="${h}cm">${inner}</draw:frame>`;
  const textBox = (t: string) => `<draw:text-box><text:p>${t}</text:p></draw:text-box>`;
  // Two landscape A4 sheets, two A5 pages each, arranged as a booklet:
  // sheet 1 = back cover | cover, sheet 2 = song | empty.
  const odg = zipSync({
    mimetype: strToU8('application/vnd.oasis.opendocument.graphics'),
    'styles.xml': strToU8(
      `<office:document-styles ${NS}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm"/></style:page-layout></office:automatic-styles></office:document-styles>`,
    ),
    'content.xml': strToU8(
      `<office:document-content ${NS}><office:body><office:drawing>` +
        `<draw:page draw:name="page1">` +
        `<draw:line svg:x1="14.85cm" svg:y1="0cm" svg:x2="14.85cm" svg:y2="21cm"><text:p/></draw:line>` +
        frame(3, 6, 9, 4, textBox('Back cover quote')) +
        frame(16, 1.5, 12, 2, textBox('SONGBOOK')) +
        `<draw:custom-shape svg:x="16cm" svg:y="18cm" svg:width="12cm" svg:height="2cm"><draw:enhanced-geometry draw:type="round-rectangle" draw:modifiers="3600"/></draw:custom-shape>` +
        frame(16.2, 18.3, 3, 1.2, textBox('Name:')) +
        `</draw:page><draw:page draw:name="page2">` +
        frame(1, 1, 13, 19, '<draw:object xlink:href="./Object 1"/>') +
        `</draw:page></office:drawing></office:body></office:document-content>`,
    ),
    'Object 1/content.xml': strToU8(
      `<office:document-content ${NS}><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style></office:automatic-styles>` +
        `<office:body><office:text><text:p text:style-name="P1">Little song</text:p><text:p/>` +
        `<text:p><text:s text:c="4"/>Do<text:s text:c="20"/>Sol</text:p>` +
        `<text:p>Una canzone semplice da cantare insieme</text:p>` +
        `</office:text></office:body></office:document-content>`,
    ),
  });

  it('splits sheets into pages in booklet order', () => {
    const book = importOdg('My book.odg', odg, fonts);
    expect(book.title).toBe('My book');
    expect(book.pageSize).toBe('A5');
    expect(book.parts.map((p) => `${p.page}:${p.kind}`)).toEqual(['1:page', '2:song', '3:blank', '4:page']);
    const song = book.parts[1];
    expect(song.kind === 'song' && song.title).toBe('Little song');
    expect(song.kind === 'song' && song.chordpro).toMatch(/\[Do\].*\[Sol\]/);
  });

  it('turns text boxes and rounded rectangles into page elements', () => {
    const cover = importOdg('b.odg', odg, fonts).parts[0];
    if (cover.kind !== 'page') throw new Error('expected a page');
    expect(cover.name).toBe('songbook');
    expect(cover.doc.elements[0]).toMatchObject({ text: 'SONGBOOK' });
    // The text box inside the rectangle becomes its label.
    expect(cover.doc.elements[1]).toMatchObject({ box: 'Name:', height: 57 });
    expect(cover.doc.elements).toHaveLength(2);
  });

  it('can read sheets in reading order', () => {
    const book = importOdg('b.odg', odg, fonts, { booklet: false });
    expect(book.parts.map((p) => `${p.page}:${p.kind}`)).toEqual(['1:page', '2:page', '3:song', '4:blank']);
  });
});
