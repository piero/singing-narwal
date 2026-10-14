// Workspace: the folder holding a group's songs (.cho), songbooks
// (.songbook.yaml) and images. Three implementations:
//
// - TinyJS (desktop app): real folder on disk, through the app backend.
// - Browser folder: File System Access API (Chromium browsers only).
// - Browser: in the browser's storage (IndexedDB), empty on first use.

import { unzipSync, zipSync } from 'fflate';
import { isFontFile } from '../core/fonts';
import { songbookFiles, type FileLoader } from '../core/songbook';
import { t } from './i18n.svelte';
import { idbDelete, idbEntries, idbGet, idbPut, idbPutAll, openDb } from './idb';

export interface Workspace extends FileLoader {
  name: string;
  /** Where the files are: 'browser' storage (not on disk) or a 'folder' on disk. */
  kind: 'browser' | 'folder';
  /** Full folder path when known (the desktop app); browsers only expose the name. */
  location?: string;
  /** Paths relative to the workspace root, using "/" separators. */
  list(): Promise<string[]>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Move a file; fails if the target exists. */
  rename(from: string, to: string): Promise<void>;
}

export const isSong = (p: string) => /\.(cho|chordpro|chopro|crd|pro)$/i.test(p);
export const isSongbook = (p: string) => /\.songbook\.ya?ml$/i.test(p);
export const isPage = (p: string) => /\.page\.ya?ml$/i.test(p);
export const isImage = (p: string) => /\.(png|jpe?g)$/i.test(p);

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Browser workspace (IndexedDB) ------------------------------------------

// Earlier versions kept files in localStorage; they are moved to IndexedDB once.
const LEGACY_FILE = 'narwal:file:';
const LEGACY_DELETED = 'narwal:deleted:';

export interface BackupState {
  /** Time of the last change to the files (ms), 0 if never changed. */
  lastChange: number;
  /** Time of the last backup (.zip download or copy to a folder), 0 if never. */
  lastBackup: number;
}

function legacyFiles(): Map<string, Uint8Array> | null {
  const files = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  let found = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const v = localStorage.getItem(key) ?? '';
      if (key.startsWith(LEGACY_FILE)) {
        found = true;
        const bytes = v.startsWith('data:') ? fromBase64(v.slice(v.indexOf(',') + 1)) : new TextEncoder().encode(v);
        files.set(key.slice(LEGACY_FILE.length), bytes);
      } else if (key.startsWith(LEGACY_DELETED)) {
        found = true;
        deleted.push(key.slice(LEGACY_DELETED.length));
      }
    }
  } catch {
    return null;
  }
  if (!found) return null;
  for (const p of deleted) files.delete(p);
  return files;
}

function clearLegacy() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
    for (const k of keys) if (k.startsWith(LEGACY_FILE) || k.startsWith(LEGACY_DELETED)) localStorage.removeItem(k);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Files kept in the browser (IndexedDB); empty on first use.
 * Writes resolve only once stored, and throw if the browser refuses them (e.g. no space).
 * Without IndexedDB, files live in memory only (`persistent` is false).
 */
export class BrowserWorkspace implements Workspace {
  kind = 'browser' as const;
  persistent: boolean;
  backup: BackupState = { lastChange: 0, lastBackup: 0 };
  /** Called after each change, with the new backup state. */
  onchange?: (b: BackupState) => void;
  /** Whether the browser has agreed not to clear these files when space runs low. */
  storageProtected = false;
  /** Called when the browser grants that protection. */
  onprotected?: () => void;
  private askedPersist = false;

  private constructor(
    private db: IDBDatabase | null,
    private files: Map<string, Uint8Array>,
  ) {
    this.persistent = !!db;
  }

  get name() {
    return t('ws.browserName');
  }

  static async open(): Promise<BrowserWorkspace> {
    const db = await openDb();
    if (!db) {
      return new BrowserWorkspace(null, legacyFiles() ?? new Map());
    }
    if (!(await idbGet(db, 'meta', 'seeded'))) {
      await idbPutAll(db, 'files', [...(legacyFiles() ?? [])]);
      await idbPut(db, 'meta', 'seeded', true);
      clearLegacy();
    }
    const ws = new BrowserWorkspace(db, new Map(await idbEntries<Uint8Array>(db, 'files')));
    ws.backup = (await idbGet<BackupState>(db, 'meta', 'backup')) ?? ws.backup;
    ws.storageProtected = await navigator.storage?.persisted?.().catch(() => false) ?? false;
    return ws;
  }

  async list() {
    return [...this.files.keys()].sort();
  }
  private get(p: string) {
    const b = this.files.get(p);
    if (b === undefined) throw new Error(`File not found: ${p}`);
    return b;
  }
  async readText(p: string) {
    return new TextDecoder().decode(this.get(p));
  }
  async readBytes(p: string) {
    return this.get(p);
  }

  private async changed() {
    this.backup = { ...this.backup, lastChange: Date.now() };
    if (this.db) await idbPut(this.db, 'meta', 'backup', this.backup).catch(() => {});
    this.onchange?.(this.backup);
    // Ask the browser not to clear these files when space runs low (granted silently or not at all,
    // except Firefox, which asks the user once).
    if (!this.askedPersist && this.db && !this.storageProtected) {
      this.askedPersist = true;
      navigator.storage
        ?.persist?.()
        .then((granted) => {
          if (!granted) return;
          this.storageProtected = true;
          this.onprotected?.();
        })
        .catch(() => {});
    }
  }

  async markBackedUp() {
    this.backup = { ...this.backup, lastBackup: Date.now() };
    if (this.db) await idbPut(this.db, 'meta', 'backup', this.backup).catch(() => {});
    this.onchange?.(this.backup);
  }

  async writeBytes(p: string, data: Uint8Array) {
    const copy = data.slice();
    if (this.db) await idbPut(this.db, 'files', p, copy);
    this.files.set(p, copy);
    await this.changed();
  }
  async writeText(p: string, text: string) {
    await this.writeBytes(p, new TextEncoder().encode(text));
  }
  async remove(p: string) {
    if (this.db) await idbDelete(this.db, 'files', p);
    this.files.delete(p);
    await this.changed();
  }
  async rename(from: string, to: string) {
    const v = this.get(from);
    if (this.files.has(to)) throw new Error(`File exists: ${to}`);
    await this.writeBytes(to, v);
    await this.remove(from);
  }
}

/** Placeholder until the real workspace is open: lists nothing and refuses writes. */
export class NoWorkspace implements Workspace {
  name = '';
  kind = 'browser' as const;
  async list() {
    return [];
  }
  async readText(p: string): Promise<string> {
    throw new Error(`File not found: ${p}`);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    throw new Error(`File not found: ${p}`);
  }
  async writeText() {
    throw new Error('No workspace open');
  }
  async writeBytes() {
    throw new Error('No workspace open');
  }
  async remove() {
    throw new Error('No workspace open');
  }
  async rename() {
    throw new Error('No workspace open');
  }
}

// --- Browser folder (File System Access API) -------------------------------

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission?(o: object): Promise<PermissionState>;
  requestPermission?(o: object): Promise<PermissionState>;
};

export class BrowserFolderWorkspace implements Workspace {
  kind = 'folder' as const;
  constructor(private root: DirHandle) {}
  get name() {
    return this.root.name;
  }
  static supported() {
    return 'showDirectoryPicker' in window;
  }
  static async pick(): Promise<BrowserFolderWorkspace> {
    const h = await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite' });
    const db = await openDb();
    if (db) await idbPut(db, 'meta', 'folder', h).catch(() => {});
    return new BrowserFolderWorkspace(h);
  }

  /** The folder used last time, if any. Browsers need the user's permission again to reopen it. */
  static async remembered(): Promise<DirHandle | null> {
    const db = await openDb();
    return (db && (await idbGet<DirHandle>(db, 'meta', 'folder').catch(() => undefined))) || null;
  }

  /** Reopen a remembered folder; `ask` shows the browser's permission prompt (needs a click). */
  static async reopen(h: DirHandle, ask: boolean): Promise<BrowserFolderWorkspace | null> {
    const o = { mode: 'readwrite' };
    let state = await h.queryPermission?.(o).catch(() => 'denied' as const);
    if (state !== 'granted' && ask) state = await h.requestPermission?.(o).catch(() => 'denied' as const);
    return state === 'granted' ? new BrowserFolderWorkspace(h) : null;
  }

  /** Start in browser storage next time. */
  static async forget() {
    const db = await openDb();
    if (db) await idbDelete(db, 'meta', 'folder').catch(() => {});
  }
  async list() {
    const out: string[] = [];
    const walk = async (dir: DirHandle, prefix: string) => {
      for await (const h of dir.values()) {
        if (h.name.startsWith('.')) continue;
        if (h.kind === 'directory') await walk(h as DirHandle, prefix + h.name + '/');
        else out.push(prefix + h.name);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }
  private async file(p: string, create = false): Promise<FileSystemFileHandle> {
    const parts = p.split('/');
    let dir: FileSystemDirectoryHandle = this.root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }
  async readText(p: string) {
    return (await (await this.file(p)).getFile()).text();
  }
  async readBytes(p: string) {
    return new Uint8Array(await (await (await this.file(p)).getFile()).arrayBuffer());
  }
  async writeText(p: string, text: string) {
    const w = await (await this.file(p, true)).createWritable();
    await w.write(text);
    await w.close();
  }
  async writeBytes(p: string, data: Uint8Array) {
    const w = await (await this.file(p, true)).createWritable();
    await w.write(data as unknown as ArrayBuffer);
    await w.close();
  }
  private async exists(p: string) {
    try {
      await this.file(p);
      return true;
    } catch {
      return false;
    }
  }
  async remove(p: string) {
    const parts = p.split('/');
    let dir: FileSystemDirectoryHandle = this.root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts[parts.length - 1]);
  }
  async rename(from: string, to: string) {
    if (await this.exists(to)) throw new Error(`File exists: ${to}`);
    await this.writeBytes(to, await this.readBytes(from));
    await this.remove(from);
  }
}

// --- TinyJS desktop app ----------------------------------------------------

interface Tiny {
  api: { call(method: string, params?: object): Promise<unknown> };
  /** Persistent settings, kept by TinyJS in ~/Library/Application Support/<app id>/. */
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  app: {
    paths(): Promise<{ home: string; documents: string; data: string }>;
    /** Files opened with the app from Finder or dropped on its Dock icon (packaged app only). */
    onOpenFiles(fn: (paths: string[]) => void): void;
  };
  dialog: {
    pickFolder(): Promise<string | null>;
    saveFile(o?: { types?: string[] }): Promise<string | null>;
    openFiles(o?: { types?: string[] }): Promise<string[] | null>;
  };
}

export function tiny(): Tiny | undefined {
  return (window as unknown as { tiny?: Tiny }).tiny;
}

/** Workspace folder created in ~/Documents on the desktop app's first launch. */
const DEFAULT_FOLDER = 'SingingNarwal';

export class TinyWorkspace implements Workspace {
  kind = 'folder' as const;
  constructor(private dir: string) {}
  get name() {
    return this.dir.split('/').pop() || this.dir;
  }
  get location() {
    return this.dir;
  }
  static async pick(): Promise<TinyWorkspace | null> {
    const dir = await tiny()!.dialog.pickFolder();
    if (!dir) return null;
    await tiny()!.store.set('folder', dir);
    return new TinyWorkspace(dir);
  }

  /**
   * The folder to start in: the one used last time, or ~/Documents/SingingNarwal
   * (created if needed) on first launch or if the last one is gone.
   */
  static async start(): Promise<{ ws: TinyWorkspace; notice?: string }> {
    const tj = tiny()!;
    const last = (await tj.store.get('folder').catch(() => null)) as string | null;
    if (last && (await tj.api.call('isDir', { path: last }).catch(() => false))) return { ws: new TinyWorkspace(last) };
    const dir = `${(await tj.app.paths()).documents}/${DEFAULT_FOLDER}`;
    await tj.api.call('makeDir', { path: dir });
    await tj.store.set('folder', dir);
    const notice = last ? t('ws.folderMissing', { path: last, fallback: dir }) : t('ws.defaultFolder', { path: dir });
    return { ws: new TinyWorkspace(dir), notice };
  }
  private call<T>(method: string, params: object) {
    return tiny()!.api.call(method, { dir: this.dir, ...params }) as Promise<T>;
  }
  list() {
    return this.call<string[]>('list', {});
  }
  readText(path: string) {
    return this.call<string>('readText', { path });
  }
  async readBytes(path: string) {
    return fromBase64(await this.call<string>('readBase64', { path }));
  }
  async writeText(path: string, text: string) {
    await this.call('writeText', { path, text });
  }
  async writeBytes(path: string, data: Uint8Array) {
    await this.call('writeBase64', { path, data: toBase64(data) });
  }
  async remove(path: string) {
    await this.call('remove', { path });
  }
  async rename(from: string, to: string) {
    await this.call('rename', { from, to });
  }
}

/** Desktop app: read files anywhere on disk (opened from Finder or picked) through the backend. */
export function readAbsoluteFiles(paths: string[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  const t = tiny()!;
  return Promise.all(paths.map(async (p) => ({ name: p.split('/').pop()!, bytes: fromBase64((await t.api.call('readAbsolute', { path: p })) as string) })));
}

/** Desktop app: pick files anywhere on disk and read them. */
export async function readExternalFiles(types = ['odt', 'odg', 'txt', 'cho', 'chordpro', 'png', 'jpg', 'jpeg', 'ttf', 'otf']): Promise<{ name: string; bytes: Uint8Array }[]> {
  const t = tiny()!;
  return readAbsoluteFiles((await t.dialog.openFiles({ types })) ?? []);
}

/** Let the user pick files from their computer: native dialog in the app, file input in the browser. */
export async function pickLocalFiles(types: string[], multiple = false): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (tiny()) return (await readExternalFiles(types)).slice(0, multiple ? undefined : 1);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = types.map((x) => '.' + x).join(',');
    input.onchange = async () =>
      resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * Copy an image chosen from the computer into the workspace's images/ folder, or reuse an
 * identical one already there. Returns its path, or null if cancelled.
 */
export async function importImage(ws: Workspace, files: string[]): Promise<string | null> {
  const [f] = await pickLocalFiles(['png', 'jpg', 'jpeg']);
  if (!f) return null;
  const dot = f.name.lastIndexOf('.');
  const base = 'images/' + f.name.slice(0, dot).replace(/[/\\:]/g, '-');
  const ext = f.name.slice(dot).toLowerCase();
  // Reuse an identical image already in the workspace, whatever its name.
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const candidates = files.filter(isImage).sort((a, b) => Number(!a.startsWith(base)) - Number(!b.startsWith(base)));
  for (const c of candidates) {
    try {
      if (same(await ws.readBytes(c), f.bytes)) return c;
    } catch {
      /* unreadable: not a match */
    }
  }
  let p = base + ext;
  for (let n = 2; files.includes(p); n++) p = `${base}-${n}${ext}`;
  await ws.writeBytes(p, f.bytes);
  return p;
}

/**
 * Save a file chosen by the user ("Save as…"): native dialog in the desktop app
 * and in Chromium browsers, a download elsewhere. Returns false if cancelled.
 */
export async function saveFile(name: string, data: Uint8Array, mime: string): Promise<boolean> {
  const t = tiny();
  if (t) {
    // The native panel takes no suggested name; the type makes macOS add the extension.
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    const path = await t.dialog.saveFile(ext ? { types: [ext] } : {});
    if (!path) return false;
    await t.api.call('writeAbsolute', { path, data: toBase64(data) });
    return true;
  }
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(data as unknown as ArrayBuffer);
      await w.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([data as unknown as ArrayBuffer], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Copy every file of a workspace into another one (e.g. from the browser to a folder). */
export async function copyWorkspace(from: Workspace, to: Workspace): Promise<number> {
  const files = await from.list();
  for (const f of files) await to.writeBytes(f, await from.readBytes(f));
  return files.length;
}

/**
 * Files to restore from a .zip backup: songs, songbooks, pages, images and fonts, at their
 * paths in the zip. A zip of a whole folder (as made by the Finder) has that folder as its
 * only top-level entry, which is dropped.
 */
export function filesFromZip(bytes: Uint8Array): [string, Uint8Array][] {
  let entries = Object.entries(unzipSync(bytes)).filter(
    ([p]) => !p.endsWith('/') && !p.split('/').some((part) => part.startsWith('.') || part === '__MACOSX'),
  );
  const tops = new Set(entries.map(([p]) => p.split('/')[0]));
  if (tops.size === 1 && entries.every(([p]) => p.includes('/'))) {
    const top = [...tops][0].length + 1;
    entries = entries.map(([p, b]) => [p.slice(top), b]);
  }
  return entries.filter(([p]) => isSong(p) || isSongbook(p) || isPage(p) || isImage(p) || isFontFile(p));
}

/** The whole workspace as a .zip file. */
export async function zipWorkspace(ws: Workspace): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of await ws.list()) entries[f] = await ws.readBytes(f);
  return zipSync(entries);
}

/**
 * One songbook and the files it uses, zipped with their workspace paths (so "Open a .zip…"
 * puts them back in place). `missing`: files the songbook lists but the workspace lacks.
 */
export async function zipSongbook(ws: Workspace, path: string): Promise<{ zip: Uint8Array; missing: string[] }> {
  const { files, missing } = await songbookFiles(path, await ws.list(), (p) => ws.readText(p));
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f] = await ws.readBytes(f);
  return { zip: zipSync(entries), missing };
}

/** Pick a folder on disk to work in, or null if cancelled / not supported. */
export async function pickFolder(): Promise<Workspace | null> {
  try {
    if (tiny()) return await TinyWorkspace.pick();
    if (BrowserFolderWorkspace.supported()) return await BrowserFolderWorkspace.pick();
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return null;
}
