// Renaming and deleting workspace files, keeping songbooks consistent: their
// references follow a renamed file, and are removed with a deleted one.

import { parseSong, serializeSong, setMeta } from '../core/chordpro';
import { slugify } from '../core/import';
import { parseSongbook, serializeSongbook, type ContentItem } from '../core/songbook';
import { isSongbook, type Workspace } from './workspace';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** Resolve a songbook-relative path to a workspace path. */
function resolveFrom(book: string, p: string): string {
  const out: string[] = [];
  for (const part of (dirOf(book) + p).split('/')) part === '..' ? out.pop() : out.push(part);
  return out.join('/');
}

/** Workspace path → path relative to the songbook. */
function relativeTo(book: string, p: string): string {
  const from = dirOf(book).split('/').filter(Boolean);
  const to = p.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return '../'.repeat(from.length - i) + to.slice(i).join('/');
}

function itemPath(c: ContentItem): string | undefined {
  if (typeof c !== 'object') return undefined;
  if ('song' in c) return c.song;
  if ('page' in c) return c.page;
  if ('image' in c) return c.image;
  return undefined;
}

/** Songbooks that include `target`, by path. */
export async function songbooksUsing(ws: Workspace, files: string[], target: string): Promise<string[]> {
  const out: string[] = [];
  for (const b of files.filter(isSongbook)) {
    if (b === target) continue;
    try {
      const book = parseSongbook(await ws.readText(b));
      if (book.contents.some((c) => itemPath(c) && resolveFrom(b, itemPath(c)!) === target)) out.push(b);
    } catch {
      /* unreadable songbook: nothing to update */
    }
  }
  return out;
}

async function updateSongbooks(ws: Workspace, books: string[], fn: (book: string, items: ContentItem[]) => ContentItem[]) {
  for (const b of books) {
    const book = parseSongbook(await ws.readText(b));
    book.contents = fn(b, book.contents);
    await ws.writeText(b, serializeSongbook(book));
  }
}

function uniquePath(files: string[], base: string, ext: string, except: string): string {
  let p = base + ext;
  for (let n = 2; files.includes(p) && p !== except; n++) p = `${base}-${n}${ext}`;
  return p;
}

/** Rename a file, updating the songbooks that refer to it. Returns the new path. */
export async function moveFile(ws: Workspace, files: string[], from: string, to: string): Promise<string> {
  if (from === to) return from;
  const books = await songbooksUsing(ws, files, from);
  await ws.rename(from, to);
  await updateSongbooks(ws, books, (b, items) =>
    items.map((c) => {
      const p = itemPath(c);
      if (!p || resolveFrom(b, p) !== from || typeof c !== 'object') return c;
      const rel = relativeTo(b, to);
      return 'song' in c ? { ...c, song: rel } : 'page' in c ? { ...c, page: rel } : { ...c, image: rel };
    }),
  );
  return to;
}

/** Change a song's title, and its file name to match. Returns the new path. */
export async function renameSong(ws: Workspace, files: string[], path: string, title: string): Promise<string> {
  const doc = setMeta(parseSong(await ws.readText(path)), 'title', title);
  await ws.writeText(path, serializeSong(doc));
  const ext = path.slice(path.lastIndexOf('.'));
  const target = uniquePath(files, dirOf(path) + slugify(title), ext, path);
  return moveFile(ws, files, path, target);
}

/** Rename a songbook or template file, keeping its extension. Returns the new path. */
export async function renameFile(ws: Workspace, files: string[], path: string, name: string): Promise<string> {
  const ext = /(\.(songbook|page)\.ya?ml|\.[^./]+)$/i.exec(path)?.[0] ?? '';
  const clean = name.replace(/[/\\:]/g, '-').trim();
  const target = uniquePath(files, dirOf(path) + clean, ext, path);
  return moveFile(ws, files, path, target);
}

/** Delete a file and remove it from the songbooks that include it. */
export async function deleteFile(ws: Workspace, files: string[], path: string) {
  const books = await songbooksUsing(ws, files, path);
  await updateSongbooks(ws, books, (b, items) => items.filter((c) => !itemPath(c) || resolveFrom(b, itemPath(c)!) !== path));
  await ws.remove(path);
}
