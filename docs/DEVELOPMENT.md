# Developer guide

How to run, test and change Singing Narwal. For how the pieces fit together, read the
[technical overview](TECHNICAL.md) first.

## Requirements

- Node.js 20.19+ or 22.12+ (required by Vite 8) and npm.
- For the desktop app: macOS and the [TinyJS](https://tinyjs.app/) CLI.

## Run it

```sh
npm install
npm run dev          # web app on http://127.0.0.1:5173, with hot reload
```

The web app starts in browser storage, pre-filled with the songs in `examples/`. In
Chrome or Edge, **Open folder…** lets you work on a real folder instead.

| Command | What it does |
|---|---|
| `npm run dev` | development server |
| `npm run build` | static site in `dist/` |
| `npm run preview` | serves `dist/` to check a build |
| `npm test` | unit tests (Vitest) |
| `npm run check` | type check: Svelte components and app code (`svelte-check`), CLI and config (`tsc`) |
| `npm run cli -- …` | command-line tool, see below |

### Command line

```sh
npm run cli -- examples/songs/aquile-randagie.cho -o song.pdf
npm run cli -- examples/canzoniere.songbook.yaml -o book.pdf
npm run cli -- import ~/Documents/Canzoniere/*.odt -o songs/
```

Options: `--page A4|A5|A6|Letter`, `--imposition single|copies|2up|booklet`,
`--notation original|italian|english`, and `--columns 1|2|auto` (single songs only).
`-o` defaults to the input name with `.pdf`.

### Desktop app

```sh
tinyjs dev           # runs the app against the Vite dev server (npm run dev)
tinyjs build --dmg   # builds the app and a .dmg into .build/
```

Configuration is in `tinyjs.json`; the backend is `tiny/backend/main.js`. The backend runs
in txiki.js, not Node: check its APIs against the txiki.js runtime that ships with TinyJS
(`~/.tinyjs/bin/tjs run script.js`), not against Node's. For example, `tjs.readFile`
always returns bytes.

## Code structure

```
src/
  main.ts                  mounts App.svelte
  globals.d.ts             type of __APP_NAME__ (the product name, from tinyjs.json)
  App.svelte               sidebar, workspace startup and switching, file menu, error bar
  app.css                  global styles and colour tokens (light/dark)
  core/                    pure TypeScript: no DOM, no Node; used by the app and the CLI
    chords.ts              chord parsing (English/Italian), transposition, spelling, formatting
    chordpro.ts            ChordPro reader/writer, one entry per source line (lossless)
    transform.ts           song-wide edits: transpose, convert notation
    layout.ts              song layout: line breaking, chord spacing, columns, auto-fit
    pages.ts               non-song pages (.page.yaml): format, layout, starter templates
    songbook.ts            songbook format (.songbook.yaml) and assembly
    impose.ts              page sizes; placing pages on sheets (copies, 2-up, booklet)
    pdf.ts                 display list → PDF (pdf-lib)
    fonts.ts               font registry, measurement (fontkit), bundled font list
    images.ts              PNG/JPEG dimensions
    import/
      index.ts             entry points: importFile, importText; plain-text reader
      odt.ts               .odt reader: styles, spacing, character positions
      xml.ts               minimal XML parser for .odt content
      sheet.ts             chords-over-lyrics → ChordPro converter
    core.test.ts           tests: chords, ChordPro, layout, imposition, transforms, pages
    import.test.ts         tests: text and .odt import
  ui/                      Svelte UI and browser-side services
    SongView.svelte        song editor screen: metadata, chord tools, preview, export
    VisualEditor.svelte    chords-over-lyrics editor and section toolbar
    BookView.svelte        songbook editor
    PageView.svelte        page (.page.yaml) editor
    ImportDialog.svelte    import of files and pasted text
    Preview.svelte         SVG rendering of sheets
    workspace.ts           Workspace interface and implementations; file dialogs; zip
    idb.ts                 IndexedDB helpers
    fileops.ts             rename/delete that keep songbooks consistent
    saves.ts               debounced autosave, pending-save tracking, error reporting
    assets.svelte.ts       fonts (bundled + workspace) and image URLs
    i18n.svelte.ts         English and Italian strings
    settings.svelte.ts     preferences remembered per browser
cli/narwal.ts              command line: PDF export and import
tiny/backend/main.js       TinyJS backend: file access on disk
public/fonts/              bundled Liberation fonts (also read by the CLI)
public/narwal-logo-256.png logo for the web page (favicon, sidebar, welcome screen)
assets/narwal-logo.png     logo master; the desktop app's icon (tinyjs.json "icon")
examples/                  sample workspace used to seed browser storage (test content)
docs/                      technical overview and this guide
```

## Testing

- **Unit tests** (`npm test`) cover `src/core`: chord parsing and transposition, the
  ChordPro round trip, song structure, layout decisions, imposition order, song
  transforms, page templates, and text/`.odt` import. Add a test with every change to
  `src/core`, especially to the layout and the importer, where small changes have
  far-reaching effects.
- **Type check** (`npm run check`) must report 0 errors and 0 warnings.
- **In the browser:** there are no automated UI tests yet. Check UI changes by hand in
  Chrome and, for storage or dialog changes, in Safari and Firefox too. A clean start
  needs the site's data cleared (DevTools → Application → Storage → Clear site data).
- **Desktop app:** backend changes can be tested by importing `tiny/backend/main.js`
  from a script run with TinyJS's `tjs`. For the whole app, build it and open it.

Before opening a pull request, run:

```sh
npm test && npm run check && npm run build
```

## Conventions

- **Keep `src/core` pure.** No DOM, browser or Node APIs there, so it keeps working in
  the browser, the desktop app and the CLI. File access goes through the `FileLoader` /
  `Workspace` interfaces.
- **Keep file formats human-readable** and stable. Songs are standard ChordPro; new song
  features should use ChordPro directives rather than a private syntax. Songbook and page
  YAML only writes options that differ from the defaults.
- **Content edits change the file; layout options don't.** Transposing and converting
  chord names rewrite the song. The preview and songbooks only decide how it is printed.
- **Every user-facing string goes in `i18n.svelte.ts`**, in both English and Italian. The
  type check fails if the Italian dictionary misses a key, or if code uses a key that
  doesn't exist.
- **Don't hard-code the product name.** It lives only in `tinyjs.json` (`"title"`): Vite
  injects it as `__APP_NAME__` and into `index.html` (`%APP_NAME%`), and the CLI reads it
  from there. Internal identifiers use the generic `narwal` (database `narwal-db`,
  storage keys `narwal:…`, app id `org.narwal.app`) and must not change with a rename:
  changing them makes users lose their browser data or settings.
- **Never report a failed save as saved.** Writes must throw on failure; autosaves go
  through `trackSave` so failures reach the error bar.
- **The logo** has one master, `assets/narwal-logo.png`. After changing it, regenerate
  the web copy: `sips -Z 256 assets/narwal-logo.png --out public/narwal-logo-256.png`.
- Match the style of the surrounding code: 2-space indentation, single quotes, short
  comments that explain why rather than what. There is no formatter configured yet.

## Contributing

Contributions are welcome, from code to translations to example songs.

1. Open an issue to discuss bigger changes before writing code.
2. Fork, create a branch, make the change with tests, and check it as described above.
3. Open a pull request explaining what changes for users and how you tested it.

By contributing you agree that your contribution is licensed under the GPL-3.0-or-later,
like the rest of the project.

- **Song lyrics:** do not commit copyrighted lyrics. Example songs must be in the public
  domain or under a licence that allows redistribution.
- **Translations:** a new interface language means a new dictionary in
  `src/ui/i18n.svelte.ts` and an entry in `LANGS`.
- **Fonts:** bundled fonts must allow redistribution (e.g. SIL OFL); add their licence
  next to them in `public/fonts/`.
- **Build output:** `dist/` and `.build/` (TinyJS) are not committed.

## Roadmap

### Done

**Songs**
- [x] ChordPro files with chords anchored to letters; Italian (Do Re Mi) and English
      (C D E) chord names; converting and transposing rewrite the song (undoable), with
      conventional spelling.
- [x] Hybrid editor: lyrics as text, chords as chips above their letters. Click to add,
      type `[Am]` inline, drag or use ←/→ to re-anchor; undo/redo; raw ChordPro view;
      autosave.
- [x] Song structure: choruses (indented, optional label), chorus repeats, instrumental
      lines, notes, forced column/page breaks, all added from a section toolbar and shown
      as markers in the editor.

**Layout and printing**
- [x] Automatic layout: one or two columns and text scale (down to 75%) chosen to use the
      fewest pages with the fewest wrapped lines; colliding chords spaced out.
- [x] Live preview drawn from the same layout as the PDF; click the preview to jump to a
      line.
- [x] PDF export with embedded fonts; A4, A5, A6, Letter, Half Letter.
- [x] Printing: 1 page per sheet, 2 copies per sheet, 2 pages per sheet, saddle-stitch
      booklets.

**Songbooks and pages**
- [x] Songbooks: songs, index with page numbers, blank pages, full-page images; per-song
      columns; page numbers on outer corners; optionally all chords in one notation.
- [x] 2-page songs start on a left page; booklet padding goes before a back cover.
- [x] Editable pages (covers, quotes, notes, ruled pages) from built-in templates: text,
      images, rounded boxes, ruled lines, flexible spacing, placeholders.
- [x] Custom fonts from the workspace's `fonts/` folder.

**Import**
- [x] `.odt`, `.txt` and pasted text with chords above the lyrics, measured with the
      document's fonts; titles, artists, choruses, labels, repeats and instrumental lines
      detected.
- [x] Command-line import and PDF rendering.

**App**
- [x] Workspaces: a folder on disk (desktop app, Chrome/Edge) or browser storage
      (IndexedDB); folder remembered between sessions; backup reminder; restore from
      `.zip`; failed saves reported.
- [x] Desktop app starts in `~/Documents/SingingNarwal` or the last folder used.
- [x] Rename and delete files, keeping songbooks consistent; save a copy of any file;
      download the workspace as a `.zip`.
- [x] English and Italian interface; GPL-3.0-or-later.

### Next

- [ ] Test the desktop app end to end; code signing; universal (Intel + Apple Silicon)
      builds; updates; Windows/Linux.
- [ ] Automated UI tests (e.g. Playwright) in Chromium, WebKit and Firefox.
- [ ] Offline support for the website (service worker).
- [ ] Chord diagrams (guitar) in free space at the end of a song or the book.
- [ ] Images inside songs (`{image: …}`), placed in free space at the end of a column.
- [ ] Style editor for songs (fonts and sizes of lyrics, chords, titles).
- [ ] Booklet options: cover from a PDF, sections with their own index.
- [ ] Import: split documents containing several songs; `.docx` directly.
- [ ] Transpose `add` notes inside suffixes (e.g. `F#(addB)`).
- [ ] Replace the example songs with public-domain ones before publishing.
