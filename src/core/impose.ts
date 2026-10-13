// Imposition: placing logical pages (e.g. A5) on the physical sheets that go
// through the printer (e.g. A4).

import type { LaidPage } from './layout';

export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  A6: { width: 297.64, height: 419.53 },
  Letter: { width: 612, height: 792 },
  'Half Letter': { width: 396, height: 612 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/**
 * - `single`: one logical page per sheet.
 * - `copies`: two copies of each page side by side, to print and cut in half.
 * - `2up`: two consecutive pages side by side.
 * - `booklet`: saddle-stitch order; fold the printed stack in half and staple.
 */
export type ImpositionKind = 'single' | 'copies' | '2up' | 'booklet';

export interface ImpositionOptions {
  kind: ImpositionKind;
  /** Draw a thin line where the sheet is cut or folded. */
  foldLine?: boolean;
}

export interface Placement {
  /** `null` is a blank page (padding for booklets). */
  page: LaidPage | null;
  x: number;
  y: number;
}

export interface Sheet {
  width: number;
  height: number;
  placements: Placement[];
  foldLine: boolean;
}

/** Saddle-stitch page order: for each sheet side, the [left, right] page indices. */
export function bookletOrder(pageCount: number): [number, number][] {
  const n = Math.ceil(pageCount / 4) * 4;
  const sides: [number, number][] = [];
  for (let i = 0; i < n / 2; i += 2) {
    sides.push([n - 1 - i, i]); // front
    sides.push([i + 1, n - 2 - i]); // back
  }
  return sides;
}

export function impose(pages: LaidPage[], opts: ImpositionOptions): Sheet[] {
  if (!pages.length) return [];
  const { width: w, height: h } = pages[0];
  const fold = !!opts.foldLine;
  const pair = (a: LaidPage | null, b: LaidPage | null): Sheet => ({
    width: 2 * w,
    height: h,
    placements: [
      { page: a, x: 0, y: 0 },
      { page: b, x: w, y: 0 },
    ],
    foldLine: fold,
  });
  switch (opts.kind) {
    case 'single':
      return pages.map((p) => ({ width: p.width, height: p.height, placements: [{ page: p, x: 0, y: 0 }], foldLine: false }));
    case 'copies':
      return pages.map((p) => pair(p, p));
    case '2up': {
      const sheets: Sheet[] = [];
      for (let i = 0; i < pages.length; i += 2) sheets.push(pair(pages[i], pages[i + 1] ?? null));
      return sheets;
    }
    case 'booklet':
      return bookletOrder(pages.length).map(([l, r]) => pair(pages[l] ?? null, pages[r] ?? null));
  }
}
