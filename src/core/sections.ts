// Edits on a range of song lines: wrap them in a section, put a break before or after
// them, remove them, copy them as ChordPro. Used by the editor's line selection.

import { parseSong, serializeLine, type SongLine } from './chordpro';

const SECTION = /^(start|end)_of_(chorus|verse|bridge|tab|grid)$/;
const BREAKS = new Set(['column_break', 'new_page', 'new_physical_page']);

function sectionMarker(l: SongLine | undefined): { type: 'start' | 'end'; env: string } | null {
  if (l?.kind !== 'directive') return null;
  const m = SECTION.exec(l.name);
  return m ? { type: m[1] as 'start' | 'end', env: m[2] } : null;
}

const isBreak = (l: SongLine | undefined, name?: string) => l?.kind === 'directive' && BREAKS.has(l.name) && (!name || l.name === name);
const isEmpty = (l: SongLine | undefined) => l?.kind === 'empty';

/** Section of each line ('' outside sections and for the start/end markers themselves). */
function envsOf(lines: SongLine[]): string[] {
  let env = '';
  return lines.map((l) => {
    const m = sectionMarker(l);
    if (m) {
      env = m.type === 'start' ? m.env : '';
      return '';
    }
    return env;
  });
}

/** Index of the marker closing the section opened at `s` (or of the one opening the section closed at `e`). */
function partner(lines: SongLine[], k: number): number {
  const m = sectionMarker(lines[k])!;
  const dir = m.type === 'start' ? 1 : -1;
  for (let j = k + dir; j >= 0 && j < lines.length; j += dir) {
    const o = sectionMarker(lines[j]);
    if (o) return o.type !== m.type ? j : -1;
  }
  return -1;
}

/** Start and end markers of the section containing line i, if any. */
function sectionAround(lines: SongLine[], i: number): [number, number] | null {
  for (let s = i - 1; s >= 0; s--) {
    const m = sectionMarker(lines[s]);
    if (!m) continue;
    if (m.type === 'end') return null;
    const e = partner(lines, s);
    return e > i ? [s, e] : null;
  }
  return null;
}

/**
 * Make lines a..b a section of kind `env` (chorus, verse, bridge). Sections they overlap
 * are split or shrunk around them; sections inside them are absorbed. If all the selected
 * lines already are such a section, they are taken out of it instead.
 * Returns the new lines and the new index of line a.
 */
export function wrapLines(lines: SongLine[], a: number, b: number, env: string): { lines: SongLine[]; first: number } {
  const envs = envsOf(lines);
  // The region to rewrite: the selection plus every section it touches.
  let ra = a;
  let rb = b;
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of [ra, rb]) {
      const s = sectionAround(lines, i);
      if (s && (s[0] < ra || s[1] > rb)) [ra, rb, changed] = [Math.min(ra, s[0]), Math.max(rb, s[1]), true];
    }
    for (let k = ra; k <= rb; k++) {
      if (!sectionMarker(lines[k])) continue;
      const p = partner(lines, k);
      if (p >= 0 && (p < ra || p > rb)) [ra, rb, changed] = [Math.min(ra, p), Math.max(rb, p), true];
    }
  }
  const content = [];
  for (let k = a; k <= b; k++) if (!sectionMarker(lines[k]) && !isEmpty(lines[k])) content.push(k);
  const target = content.length && content.every((k) => envs[k] === env) ? '' : env;
  // Labels of the sections in the region, kept on the line that starts them.
  const labels = new Map<number, { env: string; value: string }>();
  for (let k = ra; k <= rb; k++) {
    const m = sectionMarker(lines[k]);
    const l = lines[k];
    if (m?.type !== 'start' || l.kind !== 'directive' || !l.value) continue;
    let f = k + 1;
    while (f <= rb && (isEmpty(lines[f]) || sectionMarker(lines[f]))) f++;
    labels.set(f, { env: m.env, value: l.value });
  }

  const out: SongLine[] = [];
  let first = -1;
  let cur = '';
  let pending: SongLine[] = [];
  for (let k = ra; k <= rb; k++) {
    const l = lines[k];
    if (sectionMarker(l)) continue;
    if (isEmpty(l)) {
      pending.push(l);
      continue;
    }
    const e = k >= a && k <= b ? target : envs[k];
    if (e !== cur) {
      if (cur) out.push({ kind: 'directive', name: `end_of_${cur}`, value: '' });
      out.push(...pending);
      if (e) {
        const label = labels.get(k);
        out.push({ kind: 'directive', name: `start_of_${e}`, value: label?.env === e ? label.value : '' });
      }
      cur = e;
    } else out.push(...pending);
    pending = [];
    if (k >= a && first < 0) first = ra + out.length;
    out.push(l);
  }
  if (cur) out.push({ kind: 'directive', name: `end_of_${cur}`, value: '' });
  out.push(...pending);
  return { lines: [...lines.slice(0, ra), ...out, ...lines.slice(rb + 1)], first: first < 0 ? ra : first };
}

/** First and last lines of a..b with content (not empty, not a section marker). */
function contentBounds(lines: SongLine[], a: number, b: number): [number, number] {
  let s = a;
  let e = b;
  while (s < e && (isEmpty(lines[s]) || sectionMarker(lines[s]))) s++;
  while (e > s && (isEmpty(lines[e]) || sectionMarker(lines[e]))) e--;
  return [s, e];
}

/**
 * Put a break (column_break or new_page) just before or after lines a..b. A break of the
 * same kind right on the other side of them is moved rather than duplicated, so this also
 * moves lines across an existing break.
 */
export function breakAround(lines: SongLine[], a: number, b: number, name: string, where: 'before' | 'after'): SongLine[] {
  const out = [...lines];
  const [s, e] = contentBounds(lines, a, b);
  const brk: SongLine = { kind: 'directive', name, value: '' };
  if (where === 'before') {
    let pos = s;
    while (pos > 0 && sectionMarker(out[pos - 1])?.type === 'start') pos--;
    let q = e + 1;
    while (q < out.length && (isEmpty(out[q]) || sectionMarker(out[q])?.type === 'end')) q++;
    if (isBreak(out[q], name)) out.splice(q, 1);
    out.splice(pos, 0, brk);
  } else {
    let pos = e + 1;
    while (pos < out.length && sectionMarker(out[pos])?.type === 'end') pos++;
    let q = s - 1;
    while (q >= 0 && (isEmpty(out[q]) || sectionMarker(out[q])?.type === 'start')) q--;
    out.splice(pos, 0, brk);
    if (q >= 0 && isBreak(out[q], name)) out.splice(q, 1);
  }
  return out;
}

/**
 * Remove lines a..b; a section losing one of its markers loses the other one too.
 * `at`: where the removed lines were, in the new lines (to insert others in their place).
 */
export function removeLines(lines: SongLine[], a: number, b: number): { lines: SongLine[]; at: number } {
  const gone = new Set<number>();
  for (let k = a; k <= b; k++) {
    gone.add(k);
    if (sectionMarker(lines[k])) {
      const p = partner(lines, k);
      if (p >= 0) gone.add(p);
    }
  }
  return { lines: lines.filter((_, k) => !gone.has(k)), at: a - [...gone].filter((k) => k < a).length };
}

/**
 * Lines a..b to copy elsewhere: a section marker whose partner is not among them gets one,
 * so the copy has no half-open section.
 */
export function copyLines(lines: SongLine[], a: number, b: number): SongLine[] {
  const out = lines.slice(a, b + 1);
  const opened: string[] = [];
  const unopened: string[] = [];
  for (const l of out) {
    const m = sectionMarker(l);
    if (m?.type === 'start') opened.push(m.env);
    else if (m?.type === 'end') {
      if (opened.length) opened.pop();
      else unopened.push(m.env);
    }
  }
  return [
    ...unopened.reverse().map((env): SongLine => ({ kind: 'directive', name: `start_of_${env}`, value: '' })),
    ...out,
    ...opened.reverse().map((env): SongLine => ({ kind: 'directive', name: `end_of_${env}`, value: '' })),
  ];
}

/** Lines as ChordPro text (chords inline), ending with a line break. */
export function linesToText(lines: SongLine[]): string {
  return lines.map(serializeLine).join('\n') + '\n';
}

/** ChordPro text (e.g. pasted) as song lines. */
export function textToLines(text: string): SongLine[] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return parseSong(t).lines;
}
