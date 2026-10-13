// Preferences remembered between sessions (per browser / app install).

import type { Notation } from '../core/chords';
import type { ImpositionKind, PageSizeName } from '../core/impose';

export interface SongExportSettings {
  page: PageSizeName;
  imposition: ImpositionKind;
  notation: Notation;
}

const KEY = 'narwal:settings';

function load(): SongExportSettings {
  const d: SongExportSettings = { page: 'A5', imposition: 'copies', notation: 'italian' };
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
