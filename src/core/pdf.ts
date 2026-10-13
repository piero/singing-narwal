// PDF writer: draws imposed sheets with pdf-lib, embedding (subsets of) the fonts
// used by the layout.

import { PDFDocument, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontRegistry } from './fonts';
import type { Sheet } from './impose';

export interface PdfOptions {
  title?: string;
  /** Returns the bytes of an image referenced by the layout (PNG or JPEG). */
  loadImage?: (src: string) => Promise<Uint8Array>;
}

export async function renderPdf(sheets: Sheet[], fonts: FontRegistry, opts: PdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreator('Narwal Score');
  if (opts.title) doc.setTitle(opts.title);

  const embedded = new Map<string, PDFFont>();
  const font = async (id: string) => {
    let f = embedded.get(id);
    if (!f) {
      f = await doc.embedFont(fonts.data(id), { subset: true });
      embedded.set(id, f);
    }
    return f;
  };
  const images = new Map<string, PDFImage>();
  const image = async (src: string) => {
    let img = images.get(src);
    if (!img) {
      if (!opts.loadImage) throw new Error(`No image loader for ${src}`);
      const bytes = await opts.loadImage(src);
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      images.set(src, img);
    }
    return img;
  };

  for (const sheet of sheets) {
    const page = doc.addPage([sheet.width, sheet.height]);
    const H = sheet.height;
    for (const pl of sheet.placements) {
      if (!pl.page) continue;
      for (const it of pl.page.items) {
        if (it.type === 'text') {
          page.drawText(it.text, { x: pl.x + it.x, y: H - (pl.y + it.y), size: it.size, font: await font(it.font) });
        } else if (it.type === 'rule') {
          page.drawLine({
            start: { x: pl.x + it.x1, y: H - (pl.y + it.y1) },
            end: { x: pl.x + it.x2, y: H - (pl.y + it.y2) },
            thickness: it.width,
          });
        } else if (it.type === 'rect') {
          page.drawSvgPath(roundedRectPath(it.width, it.height, it.radius), {
            x: pl.x + it.x,
            y: H - (pl.y + it.y),
            borderWidth: it.lineWidth,
            borderColor: rgb(0, 0, 0),
          });
        } else if (it.type === 'image') {
          page.drawImage(await image(it.src), {
            x: pl.x + it.x,
            y: H - (pl.y + it.y + it.height),
            width: it.width,
            height: it.height,
          });
        }
      }
    }
    if (sheet.foldLine && sheet.placements.length === 2) {
      const x = sheet.width / 2;
      page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, thickness: 0.3, color: rgb(0.6, 0.7, 0.85) });
    }
  }
  return doc.save();
}

/** SVG path of a rounded rectangle with its top-left corner at the origin. */
export function roundedRectPath(w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}
