// Preferences remembered between sessions (per browser / app install).

import type { ImpositionKind, PageSizeName } from '../core/impose';

export interface SongExportSettings {
  page: PageSizeName;
  imposition: ImpositionKind;
  showChords: boolean;
  /** Font family of the song text, e.g. "LiberationSans". */
  font: string;
  /** Lyrics size in points; the other text is sized in proportion. */
  fontSize: number;
}

const KEY = 'narwal:settings';

function load(): SongExportSettings {
  const d: SongExportSettings = { page: 'A5', imposition: 'copies', showChords: true, font: 'LiberationSerif', fontSize: 11 };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return d;
  }
}

export const songSettings = $state(load());

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(songSettings));
  } catch {
    /* storage unavailable */
  }
}
