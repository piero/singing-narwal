// Workspace assets in the browser: fonts (registered for measurement, PDF and
// preview) and images (object URLs for the preview).

import { BUNDLED_FONTS, FontRegistry, fontIdForFile, isFontFile } from '../core/fonts';
import type { Workspace } from './workspace';

const bundled = new Map<string, Uint8Array>();
const registered = new Set<string>();

function registerWebFont(id: string, data: Uint8Array) {
  if (registered.has(id) || typeof FontFace === 'undefined') return;
  registered.add(id);
  const face = new FontFace(id, data.slice().buffer);
  face.load().then((f) => document.fonts.add(f)).catch(() => registered.delete(id));
}

/** Bundled fonts plus the TTF/OTF files found in the workspace. */
export async function loadFonts(workspace: Workspace, files: string[]): Promise<{ fonts: FontRegistry; errors: string[] }> {
  if (!bundled.size) {
    await Promise.all(
      BUNDLED_FONTS.map(async (id) => {
        const res = await fetch(`${import.meta.env.BASE_URL}fonts/${id}.ttf`);
        if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
        bundled.set(id, new Uint8Array(await res.arrayBuffer()));
      }),
    );
  }
  const fonts = new FontRegistry();
  const errors: string[] = [];
  for (const [id, data] of bundled) {
    fonts.add(id, data);
    registerWebFont(id, data);
  }
  for (const f of files.filter(isFontFile)) {
    try {
      const data = await workspace.readBytes(f);
      const id = fontIdForFile(f);
      fonts.add(id, data);
      registerWebFont(id, data);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { fonts, errors };
}

/** Object URLs of workspace images, for the SVG preview. */
export class ImageUrls {
  urls: Record<string, string> = $state({});
  private pending = new Set<string>();

  constructor(private load: (path: string) => Promise<Uint8Array>) {}

  get(path: string): string {
    if (!this.urls[path] && !this.pending.has(path)) {
      this.pending.add(path);
      this.load(path)
        .then((b) => (this.urls[path] = URL.createObjectURL(new Blob([b as unknown as ArrayBuffer]))))
        .catch(() => {})
        .finally(() => this.pending.delete(path));
    }
    return this.urls[path] ?? '';
  }
}
