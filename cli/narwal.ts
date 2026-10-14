// Command line:
//
//   narwal <song.cho | book.songbook.yaml> [options]     render a PDF
//   narwal import <files.odt|.txt ...> [-o songs/]       convert to ChordPro
//
//   -o, --output <file.pdf>     output file (default: input name + .pdf)
//   --page A4|A5|A6|Letter      logical page size (default A5 for books, A4 for songs)
//   --imposition single|copies|2up|booklet
//   --notation original|italian|english   print chords as written, or all in one notation
//   --columns 1|2|auto          (single songs only)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { importFile, slugify } from '../src/core/import';
import { dirname, join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadBundledFonts } from '../src/core/fonts';
import { buildSongbook, defaultSongbook, parseSongbook, type FileLoader } from '../src/core/songbook';
import { renderPdf } from '../src/core/pdf';
import type { ImpositionKind, PageSizeName } from '../src/core/impose';
import type { Notation } from '../src/core/chords';
import type { Columns } from '../src/core/layout';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    page: { type: 'string' },
    imposition: { type: 'string' },
    notation: { type: 'string' },
    columns: { type: 'string' },
  },
});

const fontDir = resolve(import.meta.dirname, '../public/fonts');
// Product name, from tinyjs.json like the app.
const appName: string = JSON.parse(await readFile(resolve(import.meta.dirname, '../tinyjs.json'), 'utf8')).title;
const fonts = await loadBundledFonts(async (f) => new Uint8Array(await readFile(join(fontDir, f))));

if (positionals[0] === 'import') {
  const outDir = values.output ?? 'songs';
  await mkdir(outDir, { recursive: true });
  for (const file of positionals.slice(1)) {
    try {
      const song = importFile(basename(file), new Uint8Array(await readFile(file)), fonts);
      let out = join(outDir, `${slugify(song.title)}.cho`);
      for (let n = 2; existsSync(out); n++) out = join(outDir, `${slugify(song.title)}-${n}.cho`);
      await writeFile(out, song.chordpro);
      console.log(`${file} → ${out}`);
    } catch (e) {
      console.error(`${file}: ${(e as Error).message}`);
    }
  }
  process.exit(0);
}

const input = positionals[0];
if (!input) {
  console.error('usage: narwal <song.cho | book.songbook.yaml> [-o out.pdf] [--page A5] [--imposition booklet] ...');
  process.exit(1);
}

const base = dirname(resolve(input));
const loader: FileLoader = {
  readText: (p) => readFile(resolve(base, p), 'utf8'),
  readBytes: async (p) => new Uint8Array(await readFile(resolve(base, p))),
};

const isBook = /\.ya?ml$/i.test(input);
const book = isBook ? parseSongbook(await readFile(input, 'utf8')) : { ...defaultSongbook(), page: 'A4' as PageSizeName, imposition: 'single' as ImpositionKind, pageNumbers: false };
if (!isBook) {
  book.contents = [
    {
      song: basename(input),
      columns: values.columns ? (values.columns === 'auto' ? 'auto' : (Number(values.columns) as 1 | 2)) : undefined,
    },
  ];
}
if (values.page) book.page = values.page as PageSizeName;
if (values.imposition) book.imposition = values.imposition as ImpositionKind;
if (values.notation) book.notation = values.notation as Notation | 'original';
if (values.columns && isBook) book.columns = values.columns as Columns;

const built = await buildSongbook(book, fonts, loader);
for (const w of built.warnings) console.warn('warning:', w);
const pdf = await renderPdf(built.sheets, fonts, { title: book.title, creator: appName, loadImage: loader.readBytes });
const out = values.output ?? input.replace(/\.(cho|chordpro|chopro|ya?ml)$/i, '') + '.pdf';
await writeFile(out, pdf);
console.log(`${out}: ${built.pages.length} pages on ${built.sheets.length} sheets`);
