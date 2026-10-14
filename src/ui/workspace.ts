// Workspace: the folder holding a group's songs (.cho), songbooks
// (.songbook.yaml) and images. Three implementations:
//
// - TinyJS (desktop app): real folder on disk, through the app backend.
// - Browser folder: File System Access API (Chromium browsers only).
// - Demo: in the browser's local storage, seeded with the bundled examples.

import { zipSync } from 'fflate';
import type { FileLoader } from '../core/songbook';

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

// --- Demo workspace --------------------------------------------------------

const examples = import.meta.glob('../../examples/**/*.{cho,yaml}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const STORAGE_PREFIX = 'narwal:file:';
// Deleted example files, which would otherwise come back on reload.
const DELETED_PREFIX = 'narwal:deleted:';

export class DemoWorkspace implements Workspace {
  name = 'Demo';
  kind = 'browser' as const;
  private files = new Map<string, string>();

  constructor() {
    for (const [k, v] of Object.entries(examples)) this.files.set(k.replace('../../examples/', ''), v);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith(STORAGE_PREFIX)) this.files.set(key.slice(STORAGE_PREFIX.length), localStorage.getItem(key) ?? '');
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith(DELETED_PREFIX)) this.files.delete(key.slice(DELETED_PREFIX.length));
      }
    } catch {
      // Storage unavailable (private mode): changes last until the page is closed.
    }
  }
  async list() {
    return [...this.files.keys()].sort();
  }
  async readText(p: string) {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`File not found: ${p}`);
    return t.startsWith('data:') ? new TextDecoder().decode(fromBase64(t.slice(t.indexOf(',') + 1))) : t;
  }
  async readBytes(p: string) {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`File not found: ${p}`);
    return t.startsWith('data:') ? fromBase64(t.slice(t.indexOf(',') + 1)) : new TextEncoder().encode(t);
  }
  private store(p: string, v: string) {
    this.files.set(p, v);
    try {
      localStorage.setItem(STORAGE_PREFIX + p, v);
      localStorage.removeItem(DELETED_PREFIX + p);
    } catch {
      /* see constructor */
    }
  }
  async writeText(p: string, text: string) {
    this.store(p, text);
  }
  async writeBytes(p: string, data: Uint8Array) {
    this.store(p, 'data:application/octet-stream;base64,' + toBase64(data));
  }
  async remove(p: string) {
    this.files.delete(p);
    try {
      localStorage.removeItem(STORAGE_PREFIX + p);
      localStorage.setItem(DELETED_PREFIX + p, '1');
    } catch {
      /* see constructor */
    }
  }
  async rename(from: string, to: string) {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`File not found: ${from}`);
    if (this.files.has(to)) throw new Error(`File exists: ${to}`);
    this.store(to, v);
    await this.remove(from);
  }
}

// --- Browser folder (File System Access API) -------------------------------

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
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
    return new BrowserFolderWorkspace(h);
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
  dialog: {
    pickFolder(): Promise<string | null>;
    saveFile(o?: object): Promise<string | null>;
    openFiles(o?: object): Promise<string[] | null>;
  };
}

export function tiny(): Tiny | undefined {
  return (window as unknown as { tiny?: Tiny }).tiny;
}

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
    return dir ? new TinyWorkspace(dir) : null;
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

/** Desktop app: pick files anywhere on disk and read them through the backend. */
export async function readExternalFiles(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const t = tiny()!;
  const paths = (await t.dialog.openFiles({ types: ['odt', 'txt', 'cho', 'chordpro', 'png', 'jpg', 'jpeg', 'ttf', 'otf'] })) ?? [];
  return Promise.all(
    paths.map(async (p) => ({ name: p.split('/').pop()!, bytes: fromBase64((await t.api.call('readAbsolute', { path: p })) as string) })),
  );
}

/** Save a generated file: native dialog in the app, download in the browser. */
/**
 * Save a file chosen by the user ("Save as…"): native dialog in the desktop app
 * and in Chromium browsers, a download elsewhere. Returns false if cancelled.
 */
export async function saveFile(name: string, data: Uint8Array, mime: string): Promise<boolean> {
  const t = tiny();
  if (t) {
    const path = await t.dialog.saveFile({ name });
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

/** The whole workspace as a .zip file. */
export async function zipWorkspace(ws: Workspace): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of await ws.list()) entries[f] = await ws.readBytes(f);
  return zipSync(entries);
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
