<p align="center"><img src="public/narwal-logo-256.png" alt="" width="160"></p>

# Singing Narwal

Songs with chords, laid out for printing, assembled into songbooks.

- **Write songs** with chords anchored to letters: edit the lyrics and the chords move
  with them.
- **Print a song** in one or two columns chosen automatically to save paper,
  optionally two copies per sheet, ready to cut.
- **Assemble a songbook** from songs, an index, a cover and other pages, and print it as
  a fold-and-staple booklet.
- **Import** the songs you already have in `.odt` (LibreOffice/Word) or `.txt` files.
- Chords in **Italian (Do Re Mi) or English (C D E)** names; convert or **transpose** a
  song in one click.
- Interface in **English and Italian**.
- Free software (GPL v3).

## Choose how to use it

| | Where your files are kept | Good for |
|---|---|---|
| **Desktop app** (macOS) | a folder on your computer, `~/Documents/SingingNarwal` by default | a group's real songbook |
| **Website in Chrome or Edge** | a folder on your computer that you choose | the same, without installing anything |
| **Website in Safari or Firefox** | inside the browser, until you download a backup | trying it out, quick edits |

The desktop app and a folder in Chrome/Edge keep your work as ordinary files: you can
back them up, sync them (iCloud, Dropbox, Drive) and share them like any other folder.
Files kept inside the browser are easier to lose (see [below](#if-you-work-in-the-browser)).

## Workflows

### Start

- **Desktop app:** open it. On first launch it creates `~/Documents/SingingNarwal` and
  works there. To use another folder, click **Open folder…**; the app reopens it next
  time.
- **Website, Chrome or Edge:** click **Open folder…** and pick (or create) a folder for
  your songbook. Next time the site reopens it, or shows **Reopen folder** if the browser
  asks for permission again.
- **Website, Safari or Firefox:** just start. Your files are kept in the browser; the
  sidebar says so and reminds you to make backups.

The sidebar always shows where the open workspace is.

### Bring in songs you already have

1. Click **Import…** and choose files, drag them onto the dialog, or paste text and click
   **Add pasted text**.
2. The files are listed under *To import*. Click a song to see its converted text (in
   ChordPro) and correct it if needed; ✕ leaves a file out.
3. Click **Done** to copy them into the workspace, or **Cancel** to import nothing.
4. Check each imported song in the editor: chords may need a nudge where the original was
   aligned by eye, or written in a font other than Times, Arial, Courier or Liberation.

| You have | Formats | What happens |
|---|---|---|
| Songs with chords on the line above the lyrics | `.odt`, `.txt`, pasted text | converted to ChordPro songs in `songs/` |
| ChordPro songs (from other apps) | `.cho`, `.chordpro`, `.chopro`, `.crd`, `.pro` | copied into `songs/` as they are |
| Pictures for covers or full pages | `.png`, `.jpg` | copied into `images/` |
| Extra fonts | `.ttf`, `.otf` | copied into `fonts/`, usable in pages |
| A backup or a zipped songbook folder | `.zip` (**Open a .zip…**) | its files are added to the workspace |

Imported files are **copied**: the originals are never changed. Word files (`.docx`,
`.doc`) must be saved as `.odt` first (in LibreOffice or Word); `.rtf` and `.pdf` cannot be
imported. A document holding many songs is imported as one song for now.

### Write a song

1. Click **+** next to *Songs* and give it a title.
2. Type the lyrics. Click above a letter to add a chord, or type it inline like `[Am]`.
   Drag a chord to move it to another letter.
3. Use the toolbar above the lyrics to mark a **Chorus**, **Verse** or **Bridge**, repeat
   the chorus, add a note or force a column/page break.
4. **Chords: Do Re Mi | C D E** converts the chord names; **Transpose −½ / +½** changes
   the key. Both edit the song and can be undone.

Changes are saved automatically. If a save fails (for example, no space left), a red
error bar says so.

### Print a song

In the preview on the right, choose the page size, how to print (1 per sheet, 2 copies per
sheet, 2 pages per sheet) and the columns, then **Export PDF**.

### Make a songbook

1. Click **+** next to *Songbooks*.
2. Add songs (one by one or all at once), an index, blank pages, images, and pages such as
   a cover or a notes page (**Add page…**, started from a template and then editable).
3. Choose the page size and printing (usually A5 booklet), then **Export PDF**.
4. Print double-sided, flipping on the short edge, fold the stack in half and staple. The
   page order is already arranged for that.

Pages and songs can be shared by several songbooks: editing one changes it everywhere.

### Save, share and back up

| To | Use |
|---|---|
| print | **Export PDF** (a song or a songbook) |
| send one song, songbook or page | ⋯ menu next to it → **Save a copy as…** (`.cho`, `.songbook.yaml`, `.page.yaml`, or the image) |
| back up everything, or move it to another computer or browser | **Download all (.zip)**, then **Open a .zip…** to restore it |
| move from the browser to a folder | **Save all to folder…** (desktop app, Chrome, Edge): copies everything and keeps working there |

The ⋯ menu also has **Rename…** and **Delete…**; songbooks that use the file are updated.

### If you work in the browser

Files kept in the browser stay there when you reload the page or close the browser, and
are there at your next visit. They are **lost** if:

- you used a **private window** (deleted when it closes);
- you **clear the browser's data** for the site;
- you use **Safari** and don't open the site for **7 days**;
- the computer runs out of disk space and the browser needs room.

They also exist only in **that browser, on that computer, at that web address**: another
browser or device sees none of them. So **Download all (.zip)** regularly; the sidebar
shows the date of your last backup and warns when something changed since.

## More

- [Technical overview](docs/TECHNICAL.md): architecture, file formats, storage, distribution.
- [Developer guide](docs/DEVELOPMENT.md): code structure, running and testing, contributing,
  roadmap.

## Licence

Singing Narwal is free software under the [GNU General Public License v3.0 or later](LICENSE).
Songbooks you make with it are yours and are not covered by the GPL. The example songs in
`examples/` are for local testing only: most lyrics are copyrighted.
