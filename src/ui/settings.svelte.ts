// Preferences remembered between sessions (per browser / app install).

import type { ImpositionKind, PageSizeName } from '../core/impose';

export interface SongExportSettings {
  page: PageSizeName;
  imposition: ImpositionKind;
}

const KEY = 'narwal:settings';

function load(): SongExportSettings {
  const d: SongExportSettings = { page: 'A5', imposition: 'copies' };
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
