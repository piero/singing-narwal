<script lang="ts" module>
  /** Metadata directives, edited in the form above the editor rather than inline. */
  export const META = new Set(['title', 'subtitle', 'artist', 'key', 'columns', 'capo', 'tempo', 'time', 'album', 'year', 'composer', 'lyricist', 'copyright']);
</script>

<script lang="ts">
  // Hybrid song editor: one text field per line, with the chords drawn above the
  // letters they are anchored to. Long lines wrap; each chord follows its letter onto
  // the row where the browser placed it (measured on a hidden copy of the field).
  //
  // - Type lyrics as usual: chords stay attached to their letters.
  // - Click above a letter to add a chord; type "[Am]" inline works too.
  // - Drag a chord, or select it and use ←/→, to anchor it to another letter.
  // - Double-click (or Enter on) a chord to rename it; Delete removes it.
  // - Sections (chorus, verse, bridge), chorus repeats, breaks and notes are added
  //   from the toolbar and shown as markers; in the file they are ChordPro
  //   directives such as {start_of_chorus}. Other directives can be typed as "{…}".
  // - Whole lines can be selected (Shift+click, Shift+↑/↓, or "Select lines" on touch
  //   screens) to make them a section, put a break around them, or cut/copy/paste them
  //   with their chords (as ChordPro text).
  import { tick } from 'svelte';
  import { t, type Key } from './i18n.svelte';
  import { parseLyricsLine, parseSong, serializeLine, type ChordAnchor, type SongDoc, type SongLine } from '../core/chordpro';
  import { breakAround, copyLines, linesToText, removeLines, textToLines, wrapLines } from '../core/sections';

  let { doc, onchange, focusRequest }: { doc: SongDoc; onchange: (d: SongDoc) => void; focusRequest?: { line: number; n: number } } = $props();

  const FONT = '16px "LiberationSerif-Regular", "Times New Roman", serif';
  const ctx = document.createElement('canvas').getContext('2d')!;
  let fontEpoch = $state(0);
  document.fonts?.ready.then(() => fontEpoch++);
  document.fonts?.load(FONT).then(() => fontEpoch++);

  function xAt(text: string, pos: number): number {
    void fontEpoch;
    ctx.font = FONT;
    return ctx.measureText(text.slice(0, pos)).width;
  }

  const CHIP_FONT = 'bold 13px "LiberationSerif-Bold", "Times New Roman", serif';
  /** Space above each line's first row (the rows' own line height leaves room for chords). */
  const PAD_TOP = 4;
  /** Height of the chord band above a row of text. */
  const CHIP_H = 17;

  /** Measured layout of a lyrics line: rows, and where each chord chip goes. */
  interface Geo {
    rows: number;
    /** Row height. */
    lh: number;
    /** Top of the first row's glyphs, within the field. */
    h: number;
    chips: { x: number; y: number }[];
  }

  let mirror: HTMLDivElement | undefined = $state();

  /** Prepare the hidden copy of a field: same width and line height. */
  function setupMirror(ta: HTMLTextAreaElement) {
    const m = mirror!;
    m.style.width = ta.clientWidth + 'px';
    m.style.lineHeight = getComputedStyle(ta).lineHeight;
    m.textContent = '';
    return m;
  }

  /** Rows of a text in a field, and the glyph top of the first row. */
  function rowsOf(ta: HTMLTextAreaElement, text: string): { rows: number; lh: number; h: number } {
    const m = setupMirror(ta);
    const probe = document.createElement('span');
    probe.textContent = '\u200b';
    m.append(probe, text, '\u200b');
    const lh = parseFloat(m.style.lineHeight) || 34;
    return { rows: Math.max(1, Math.round(m.offsetHeight / lh)), lh, h: probe.offsetTop };
  }

  /** Position (left, glyph top) in the field of the character boundary at each `pos`. */
  function pointsOf(ta: HTMLTextAreaElement, text: string, positions: number[]): { x: number; top: number }[] {
    const m = setupMirror(ta);
    const max = Math.max(text.length, ...positions);
    // A character at every position, even past the end (trailing spaces hang, so the rows don't change).
    const padded = text + ' '.repeat(max - text.length + 1);
    const spans = new Map<number, HTMLSpanElement>();
    let last = 0;
    for (const pos of [...new Set(positions)].sort((a, b) => a - b)) {
      if (pos > last) m.append(padded.slice(last, pos));
      const span = document.createElement('span');
      span.textContent = padded[pos];
      m.append(span);
      spans.set(pos, span);
      last = pos + 1;
    }
    m.append(padded.slice(last));
    return positions.map((pos) => ({ x: spans.get(pos)!.offsetLeft, top: spans.get(pos)!.offsetTop }));
  }

  /** Layout of a lyrics line: chips above their letters, pushed right when they would overlap. */
  function measure(ta: HTMLTextAreaElement, text: string, chords: ChordAnchor[], positions: number[]): Geo {
    const { rows, lh, h } = rowsOf(ta, text);
    const pts = pointsOf(ta, text, positions);
    ctx.font = CHIP_FONT;
    const order = chords.map((_, k) => k).sort((a, b) => pts[a].top - pts[b].top || positions[a] - positions[b]);
    const chips: Geo['chips'] = [];
    let rowTop = -Infinity;
    let end = -Infinity;
    for (const k of order) {
      if (pts[k].top !== rowTop) [rowTop, end] = [pts[k].top, -Infinity];
      const x = Math.max(pts[k].x, end);
      end = x + ctx.measureText(chords[k].chord).width + 6;
      chips[k] = { x, y: PAD_TOP + pts[k].top - CHIP_H + 1 };
    }
    return { rows, lh, h, chips };
  }

  /** Character boundary nearest to x on a given row of a field (may be past the end of the text). */
  function posInRow(ta: HTMLTextAreaElement, text: string, row: number, x: number): number {
    const { rows, lh, h } = rowsOf(ta, text);
    const m = setupMirror(ta);
    const spans: [number, HTMLSpanElement][] = [];
    let i = 0;
    for (const ch of text) {
      const span = document.createElement('span');
      span.textContent = ch;
      m.append(span);
      spans.push([i, span]);
      i += ch.length;
    }
    const rowOf = (s: HTMLSpanElement) => Math.round((s.offsetTop - h) / lh);
    const onRow = spans.filter(([, s]) => rowOf(s) === row);
    ctx.font = FONT;
    const space = ctx.measureText(' ').width;
    if (!onRow.length) return text.length + Math.max(0, Math.round(x / space));
    for (const [idx, s] of onRow) if (x < s.offsetLeft + s.offsetWidth / 2) return idx;
    const [lastIdx, lastSpan] = onRow[onRow.length - 1];
    const after = lastIdx + (text.codePointAt(lastIdx)! > 0xffff ? 2 : 1);
    // Past the last letter of the last row: count spaces, as a chord may sit after the text.
    if (row >= rows - 1) return after + Math.max(0, Math.round((x - lastSpan.offsetLeft - lastSpan.offsetWidth) / space));
    return after;
  }

  /** Row under a point (y relative to the field's top), and whether it is in the chord band. */
  function zoneAt(g: Geo, y: number): { row: number; chords: boolean } {
    const row = Math.min(g.rows - 1, Math.max(0, Math.floor((y - g.h + CHIP_H) / g.lh)));
    return { row, chords: y < row * g.lh + g.h + 1 };
  }

  /** Focusable element of each line: the text field, or the marker. */
  let inputs: HTMLElement[] = $state([]);
  /** Line holding the cursor, target of the toolbar actions. */
  let cursor = $state(0);
  let selected: { line: number; idx: number } | null = $state(null);
  let editing: { line: number; idx: number | null; pos: number; value: string; x: number; y: number } | null = $state(null);
  let drag: { line: number; idx: number; startX: number; pos: number; moved: boolean } | null = $state(null);
  /** Line whose chord band is under the pointer (to show the add-chord cursor). */
  let hoverAdd = $state(-1);

  // Layout of each lyrics line, measured after rendering and whenever the width changes.
  let geo: (Geo | undefined)[] = $state([]);
  let widthEpoch = $state(0);
  let editorEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!editorEl) return;
    let w = editorEl.clientWidth;
    const ro = new ResizeObserver(() => {
      if (editorEl && editorEl.clientWidth !== w) {
        w = editorEl.clientWidth;
        widthEpoch++;
      }
    });
    ro.observe(editorEl);
    return () => ro.disconnect();
  });
  $effect(() => {
    void fontEpoch;
    void widthEpoch;
    if (!mirror) return;
    const d = drag;
    geo = doc.lines.map((l, i) => {
      const ta = inputs[i];
      if ((l.kind !== 'lyrics' && l.kind !== 'empty') || !(ta instanceof HTMLTextAreaElement)) return undefined;
      const { text, chords } = lyr(l);
      return measure(ta, text, chords, chords.map((c, k) => (d && d.line === i && d.idx === k ? d.pos : c.pos)));
    });
  });

  // Environment (chorus, verse, …) of each line, for visual grouping.
  const envs = $derived.by(() => {
    let env = '';
    return doc.lines.map((l) => {
      if (l.kind === 'directive') {
        const m = /^start_of_(\w+)/.exec(l.name);
        if (m) {
          env = m[1];
          return '';
        }
        if (l.name.startsWith('end_of_')) {
          env = '';
          return '';
        }
      }
      return env;
    });
  });

  function update(lines: SongLine[]) {
    onchange({ lines });
  }

  function setLine(i: number, l: SongLine) {
    const lines = [...doc.lines];
    lines[i] = l;
    update(lines);
  }

  function lyr(l: SongLine): { text: string; chords: ChordAnchor[] } {
    return l.kind === 'lyrics' ? l : { text: l.kind === 'empty' ? '' : serializeLine(l), chords: [] };
  }

  function makeLine(text: string, chords: ChordAnchor[]): SongLine {
    if (!chords.length && /^\s*[{#]/.test(text)) return parseSong(text).lines[0] ?? { kind: 'empty' };
    if (!chords.length && text.trim() === '') return { kind: 'empty' };
    return { kind: 'lyrics', text, chords };
  }

  /** Keep chords on their letters across a text edit, using the changed range. */
  function shiftChords(oldText: string, newText: string, chords: ChordAnchor[]): ChordAnchor[] {
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let endOld = oldText.length;
    let endNew = newText.length;
    while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const delta = endNew - endOld;
    return chords.map((c) => {
      if (c.pos < start) return c;
      // A chord past the end of the line takes the first letter typed after it.
      if (c.pos === oldText.length && start === oldText.length) return c;
      if (c.pos >= endOld) return { ...c, pos: c.pos + delta };
      // The anchored letter was replaced: stay within the new text.
      return { ...c, pos: start + Math.min(c.pos - start, endNew - start) };
    });
  }

  async function onInput(i: number, e: Event) {
    const input = e.currentTarget as HTMLTextAreaElement;
    const old = lyr(doc.lines[i]);
    const isRaw = doc.lines[i].kind === 'directive' || doc.lines[i].kind === 'comment';
    let value = input.value;
    let caret = input.selectionStart ?? value.length;
    let chords = isRaw ? [] : shiftChords(old.text, value, old.chords);
    if (/[\r\n]/.test(value)) return splitPasted(i, value, chords, caret);
    // Chords typed inline as [Am] become anchors.
    if (!/^\s*[{#]/.test(value) && /\[[^\]]*\]/.test(value)) {
      const before = parseLyricsLine(value.slice(0, caret)).text.length;
      const withAnchors = [...chords].sort((a, b) => b.pos - a.pos).reduce((s, c) => s.slice(0, c.pos) + `[${c.chord}]` + s.slice(c.pos), value);
      const parsed = parseLyricsLine(withAnchors);
      value = parsed.text;
      chords = parsed.chords;
      caret = before;
    }
    const typed = input.value;
    setLine(i, makeLine(value, chords));
    if (value !== typed) {
      await tick();
      (inputs[i] as HTMLTextAreaElement | undefined)?.setSelectionRange(caret, caret);
    }
  }

  /** Text with line breaks (pasted or dropped) becomes several lines; [chords] in it are kept. */
  function splitPasted(i: number, value: string, chords: ChordAnchor[], caret: number) {
    const withAnchors = [...chords].sort((a, b) => b.pos - a.pos).reduce((s, c) => s.slice(0, c.pos) + `[${c.chord}]` + s.slice(c.pos), value);
    const anchorsBefore = chords.filter((c) => c.pos <= caret).reduce((n, c) => n + c.chord.length + 2, 0);
    const parts = withAnchors.split(/\r\n?|\n/);
    const toLine = (src: string): SongLine => {
      if (/^\s*[{#]/.test(src)) return makeLine(src, []);
      const parsed = parseLyricsLine(src);
      return makeLine(parsed.text, parsed.chords);
    };
    const lines = [...doc.lines];
    lines.splice(i, 1, ...parts.map(toLine));
    update(lines);
    // Caret: at the end of what was pasted, on the line it ended on.
    const before = withAnchors.slice(0, caret + anchorsBefore).split(/\r\n?|\n/);
    const last = before[before.length - 1];
    focusLine(i + before.length - 1, /^\s*[{#]/.test(last) ? last.length : parseLyricsLine(last).text.length);
  }

  async function focusLine(i: number, caret: number) {
    await tick();
    const el = inputs[i];
    if (!el) return;
    // Markers with a field (label, note) focus the field.
    const field = el instanceof HTMLTextAreaElement ? el : el.querySelector('input');
    (field ?? el).focus();
    if (el instanceof HTMLTextAreaElement) {
      const c = Math.min(caret, el.value.length);
      el.setSelectionRange(c, c);
    }
  }

  $effect(() => {
    if (focusRequest) focusLine(focusRequest.line, 0);
  });

  function visibleNeighbour(i: number, dir: 1 | -1): number {
    for (let j = i + dir; j >= 0 && j < doc.lines.length; j += dir) {
      const l = doc.lines[j];
      if (!(l.kind === 'directive' && META.has(l.name))) return j;
    }
    return -1;
  }

  function onKeydown(i: number, e: KeyboardEvent) {
    const input = e.currentTarget as HTMLTextAreaElement;
    const caret = input.selectionStart ?? 0;
    const collapsed = input.selectionStart === input.selectionEnd;
    const l = doc.lines[i];
    const { text, chords } = lyr(l);
    if (e.key === 'Enter') {
      e.preventDefault();
      const lines = [...doc.lines];
      if (l.kind === 'lyrics' || l.kind === 'empty') {
        lines.splice(
          i,
          1,
          makeLine(text.slice(0, caret), chords.filter((c) => c.pos < caret)),
          makeLine(text.slice(caret), chords.filter((c) => c.pos >= caret).map((c) => ({ ...c, pos: c.pos - caret }))),
        );
      } else lines.splice(i + 1, 0, { kind: 'empty' });
      update(lines);
      focusLine(i + 1, 0);
    } else if (e.key === 'Backspace' && collapsed && caret === 0 && i > 0) {
      const p = visibleNeighbour(i, -1);
      if (p < 0) return;
      const prev = doc.lines[p];
      if (prev.kind === 'lyrics' || prev.kind === 'empty' || l.kind === 'empty') {
        e.preventDefault();
        const lines = [...doc.lines];
        if (prev.kind === 'lyrics' || prev.kind === 'empty') {
          const pv = lyr(prev);
          const merged = makeLine(pv.text + text, [...pv.chords, ...chords.map((c) => ({ ...c, pos: c.pos + pv.text.length }))]);
          lines.splice(p, i - p + 1, merged);
          update(lines);
          focusLine(p, pv.text.length);
        } else {
          lines.splice(i, 1);
          update(lines);
          focusLine(p, Infinity);
        }
      }
    } else if (e.key === 'Delete' && collapsed && caret === text.length && (l.kind === 'lyrics' || l.kind === 'empty')) {
      const n = visibleNeighbour(i, 1);
      if (n < 0) return;
      const next = doc.lines[n];
      if (next.kind === 'lyrics' || next.kind === 'empty') {
        e.preventDefault();
        const nv = lyr(next);
        const lines = [...doc.lines];
        lines.splice(i, n - i + 1, makeLine(text + nv.text, [...chords, ...nv.chords.map((c) => ({ ...c, pos: c.pos + text.length }))]));
        update(lines);
        focusLine(i, text.length);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp';
      const g = geo[i];
      let x = 0;
      if (g) {
        // Within a wrapped line, the field moves between its own rows.
        const pt = pointsOf(input, text, [caret])[0];
        const row = Math.round((pt.top - g.h) / g.lh);
        if (up ? row > 0 : row < g.rows - 1) return;
        x = pt.x;
      }
      const j = visibleNeighbour(i, up ? -1 : 1);
      if (j < 0) return;
      e.preventDefault();
      if (e.shiftKey) {
        sel = { anchor: i, head: j };
        editorEl?.focus({ preventScroll: true });
        return;
      }
      const target = inputs[j];
      const tg = geo[j];
      focusLine(j, target instanceof HTMLTextAreaElement && tg ? posInRow(target, lyr(doc.lines[j]).text, up ? tg.rows - 1 : 0, x) : 0);
    }
  }

  // --- Sections and markers ----------------------------------------------

  type Marker = { type: 'start' | 'end'; env: string } | { type: 'repeat' } | { type: 'break'; page: boolean } | { type: 'note' };

  function markerOf(l: SongLine): Marker | null {
    if (l.kind !== 'directive') return null;
    const m = /^(start|end)_of_(chorus|verse|bridge|tab|grid)$/.exec(l.name);
    if (m) return { type: m[1] as 'start' | 'end', env: m[2] };
    if (l.name === 'chorus') return { type: 'repeat' };
    if (l.name === 'column_break') return { type: 'break', page: false };
    if (l.name === 'new_page' || l.name === 'new_physical_page') return { type: 'break', page: true };
    if (/^comment(_italic|_box)?$/.test(l.name)) return { type: 'note' };
    return null;
  }

  const ENV_LABEL: Record<string, Key> = {
    chorus: 'sec.chorus',
    verse: 'sec.verse',
    bridge: 'sec.bridge',
    tab: 'sec.tab',
    grid: 'sec.tab',
  };

  const isContent = (l: SongLine) => l.kind === 'lyrics' || l.kind === 'comment' || (l.kind === 'directive' && markerOf(l)?.type === 'note');

  /** Start/end markers of the section containing line i, if any. */
  function enclosing(i: number): { start: number; end: number; env: string } | null {
    for (let s = i; s >= 0; s--) {
      const m = markerOf(doc.lines[s]);
      if (m?.type === 'end' && s !== i) return null;
      if (m?.type === 'start') {
        for (let e = Math.max(i, s + 1); e < doc.lines.length; e++) {
          const me = markerOf(doc.lines[e]);
          if (me?.type === 'end') return { start: s, end: e, env: m.env };
          if (me?.type === 'start') break;
        }
        return null;
      }
    }
    return null;
  }

  /** The paragraph around line i: consecutive lyrics/note lines. */
  function paragraph(i: number): [number, number] {
    let a = i;
    let b = i;
    while (a > 0 && isContent(doc.lines[a - 1])) a--;
    while (b + 1 < doc.lines.length && isContent(doc.lines[b + 1])) b++;
    return [a, b];
  }

  const at = () => Math.min(Math.max(0, cursor), Math.max(0, doc.lines.length - 1));
  const currentEnv = $derived(doc.lines.length ? (enclosing(at())?.env ?? '') : '');

  /** Wrap the current paragraph in a section, change its kind, or unwrap it. */
  function toggleSection(env: string) {
    const lines = [...doc.lines];
    const i = at();
    const enc = enclosing(i);
    if (enc) {
      if (enc.env === env) {
        lines.splice(enc.end, 1);
        lines.splice(enc.start, 1);
        update(lines);
        cursor = Math.max(0, i - 1);
      } else {
        lines[enc.start] = { kind: 'directive', name: `start_of_${env}`, value: (lines[enc.start] as { value: string }).value };
        lines[enc.end] = { kind: 'directive', name: `end_of_${env}`, value: '' };
        update(lines);
      }
      return;
    }
    if (!lines.length || !isContent(lines[i])) {
      // Nothing to wrap: open an empty section here.
      lines.splice(i + (lines.length ? 1 : 0), 0, { kind: 'directive', name: `start_of_${env}`, value: '' }, { kind: 'empty' }, { kind: 'directive', name: `end_of_${env}`, value: '' });
      update(lines);
      focusLine(i + (doc.lines.length ? 2 : 1), 0);
      return;
    }
    const [a, b] = paragraph(i);
    lines.splice(b + 1, 0, { kind: 'directive', name: `end_of_${env}`, value: '' });
    lines.splice(a, 0, { kind: 'directive', name: `start_of_${env}`, value: '' });
    update(lines);
    cursor = i + 1;
  }

  /** Insert a marker after the current paragraph (or section), as its own paragraph. */
  function insertAfter(line: SongLine) {
    const lines = [...doc.lines];
    const i = at();
    const enc = enclosing(i);
    let pos = enc ? enc.end + 1 : lines.length && isContent(lines[i]) ? paragraph(i)[1] + 1 : i + 1;
    pos = Math.min(pos, lines.length);
    const add: SongLine[] = [];
    if (pos > 0 && lines[pos - 1]?.kind !== 'empty') add.push({ kind: 'empty' });
    add.push(line);
    lines.splice(pos, 0, ...add);
    update(lines);
    focusLine(pos + add.length - 1, 0);
  }

  /** Insert a break before the current paragraph (or section). */
  function insertBreak(page: boolean) {
    const lines = [...doc.lines];
    const i = at();
    const enc = enclosing(i);
    const pos = enc ? enc.start : lines.length && isContent(lines[i]) ? paragraph(i)[0] : i;
    lines.splice(pos, 0, { kind: 'directive', name: page ? 'new_page' : 'column_break', value: '' });
    update(lines);
    cursor = i + 1;
  }

  function insertNote() {
    const lines = [...doc.lines];
    const i = at();
    const note: SongLine = { kind: 'directive', name: 'comment', value: '' };
    if (lines[i]?.kind === 'empty') lines[i] = note;
    else lines.splice(i + 1, 0, note);
    const pos = lines[i] === note ? i : i + 1;
    update(lines);
    focusLine(pos, 0);
  }

  /** Remove a marker; removing either end of a section removes both. */
  function removeMarker(i: number) {
    const lines = [...doc.lines];
    const m = markerOf(lines[i]);
    if (m?.type === 'start' || m?.type === 'end') {
      const enc = enclosing(m.type === 'start' ? i + 1 : i - 1) ?? (m.type === 'start' ? enclosing(i) : null);
      if (enc) {
        lines.splice(enc.end, 1);
        lines.splice(enc.start, 1);
        update(lines);
        focusLine(Math.max(0, Math.min(i, lines.length - 1)), 0);
        return;
      }
    }
    lines.splice(i, 1);
    update(lines);
    focusLine(Math.max(0, Math.min(i, lines.length - 1)), 0);
  }

  function setValue(i: number, value: string) {
    const l = doc.lines[i];
    if (l.kind === 'directive') setLine(i, { ...l, value });
  }

  function markerKey(i: number, e: KeyboardEvent) {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    if (e.key === 'Enter') {
      e.preventDefault();
      const lines = [...doc.lines];
      lines.splice(i + 1, 0, { kind: 'empty' });
      update(lines);
      focusLine(i + 1, 0);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (!input || input.value === '')) {
      e.preventDefault();
      removeMarker(i);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const j = visibleNeighbour(i, e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0) return;
      e.preventDefault();
      if (e.shiftKey) {
        sel = { anchor: i, head: j };
        editorEl?.focus({ preventScroll: true });
      } else focusLine(j, 0);
    }
  }

  /** First line of the chorus a repeat refers to, shown as a hint. */
  function chorusHint(i: number): string {
    for (let j = i - 1; j >= 0; j--) {
      const m = markerOf(doc.lines[j]);
      if (m?.type === 'start' && m.env === 'chorus') {
        const first = doc.lines.slice(j + 1).find((l) => l.kind === 'lyrics');
        return first && first.kind === 'lyrics' ? first.text.trim() + '…' : '';
      }
    }
    return '';
  }

  // --- Line selection -----------------------------------------------------

  /** Whole lines selected (anchor: where the selection started), for section, break and clipboard actions. */
  let sel = $state<{ anchor: number; head: number } | null>(null);
  /** Touch screens have no Shift key: in this mode, tapping lines selects them. */
  let selectMode = $state(false);
  const range = $derived(sel ? ([Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)] as const) : null);
  const inRange = (i: number) => !!range && i >= range[0] && i <= range[1];
  /** Section shared by all the selected lines with content, if any. */
  const selEnv = $derived.by(() => {
    if (!range) return '';
    const kinds = new Set<string>();
    for (let k = range[0]; k <= range[1]; k++) if (isContent(doc.lines[k])) kinds.add(envs[k]);
    return kinds.size === 1 ? [...kinds][0] : '';
  });

  function selectTo(i: number) {
    sel = { anchor: sel?.anchor ?? (selectMode ? i : at()), head: i };
    editing = null;
    selected = null;
    editorEl?.focus({ preventScroll: true });
  }

  function clearSel() {
    sel = null;
    selectMode = false;
  }

  /** Shift+click (or a tap in selection mode) selects lines; a plain click clears the selection. */
  function linePointer(i: number, e: PointerEvent | MouseEvent) {
    if (e.shiftKey || selectMode) {
      if ((e.target as HTMLElement).closest('.remove')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'pointerdown') selectTo(i);
    } else if (sel && e.type === 'pointerdown') clearSel();
  }

  /** The selected lines to copy (metadata such as the title stays out). */
  const selLines = () => copyLines(doc.lines, range![0], range![1]).filter((l) => !(l.kind === 'directive' && META.has(l.name)));

  function deleteSel() {
    if (!range) return;
    const r = removeLines(doc.lines, range[0], range[1]);
    update(r.lines.length ? r.lines : [{ kind: 'empty' }]);
    clearSel();
    focusLine(Math.min(r.at, Math.max(0, r.lines.length - 1)), 0);
  }

  function pasteOverSel(text: string) {
    if (!range) return;
    const r = removeLines(doc.lines, range[0], range[1]);
    const pasted = textToLines(text);
    const lines = [...r.lines];
    lines.splice(r.at, 0, ...pasted);
    update(lines);
    clearSel();
    focusLine(r.at + pasted.length - 1, Infinity);
  }

  /** Copy for the toolbar buttons (keyboard shortcuts use the clipboard event instead). */
  async function writeClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      editorEl?.focus({ preventScroll: true });
    }
  }

  const selFocused = () => !!sel && document.activeElement === editorEl;

  function onCopy(e: ClipboardEvent) {
    if (!selFocused()) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', linesToText(selLines()));
  }

  function onCut(e: ClipboardEvent) {
    if (!selFocused()) return;
    onCopy(e);
    deleteSel();
  }

  function onPaste(e: ClipboardEvent) {
    if (!selFocused()) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) pasteOverSel(text);
  }

  /** Lines pasted at the start or end of a line go before or after it, whole. */
  function fieldPaste(i: number, e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\r\n]/.test(text)) return;
    const ta = e.currentTarget as HTMLTextAreaElement;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const atStart = ta.selectionStart === 0;
    const atEnd = ta.selectionStart === ta.value.length;
    // In the middle of a line, the line is split where the text goes (see splitPasted).
    if (!atStart && !atEnd) return;
    e.preventDefault();
    const pasted = textToLines(text);
    const lines = [...doc.lines];
    const empty = doc.lines[i].kind === 'empty';
    const pos = empty || atStart ? i : i + 1;
    lines.splice(pos, empty ? 1 : 0, ...pasted);
    update(lines);
    focusLine(pos + pasted.length - 1, Infinity);
  }

  /** Keys while lines are selected (the editor itself has the focus). */
  function editorKey(e: KeyboardEvent) {
    if (!sel || e.target !== editorEl) return;
    if (e.key === 'Escape') {
      const head = sel.head;
      clearSel();
      focusLine(head, 0);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const j = visibleNeighbour(sel.head, e.key === 'ArrowUp' ? -1 : 1);
      if (e.shiftKey) {
        if (j >= 0) sel = { ...sel, head: j };
      } else {
        const target = j >= 0 ? j : sel.head;
        clearSel();
        focusLine(target, 0);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSel();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) clearSel();
  }

  function wrapSel(env: string) {
    if (!range) return;
    const r = wrapLines(doc.lines, range[0], range[1], env);
    update(r.lines);
    clearSel();
    cursor = r.first;
    focusLine(r.first, 0);
  }

  function breakSel(page: boolean, where: 'before' | 'after') {
    if (!range) return;
    update(breakAround(doc.lines, range[0], range[1], page ? 'new_page' : 'column_break', where));
    clearSel();
  }

  // --- Chords -------------------------------------------------------------

  /** Row and character boundary under a pointer in a lyrics line, and whether it is in a chord band. */
  function hit(i: number, e: PointerEvent | MouseEvent): { pos: number; chords: boolean } | null {
    const ta = inputs[i];
    if (!(ta instanceof HTMLTextAreaElement)) return null;
    const text = lyr(doc.lines[i]).text;
    // Measured now: row heights can change on hover (empty lines grow).
    const r = ta.getBoundingClientRect();
    const z = zoneAt({ ...rowsOf(ta, text), chips: [] }, e.clientY - r.top);
    return { pos: posInRow(ta, text, z.row, e.clientX - r.left), chords: z.chords };
  }

  /** Position of a new or renamed chord's field, from the line's layout. */
  function chordFieldAt(i: number, pos: number): { x: number; y: number } {
    const ta = inputs[i];
    if (!(ta instanceof HTMLTextAreaElement)) return { x: 0, y: 0 };
    const pt = pointsOf(ta, lyr(doc.lines[i]).text, [pos])[0];
    return { x: pt.x, y: PAD_TOP + pt.top - CHIP_H + 1 };
  }

  /** Click in the band above a row of text: add a chord on the letter below. */
  function lyricDown(i: number, e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.chip, .chord-input')) return;
    const h = hit(i, e);
    if (!h?.chords) return;
    // Keep the browser from moving focus away from the chord field we open.
    e.preventDefault();
    editing = { line: i, idx: null, pos: h.pos, value: '', ...chordFieldAt(i, h.pos) };
    selected = null;
  }

  function lyricHover(i: number, e: PointerEvent) {
    if (drag || (e.target as HTMLElement).closest('.chip, .chord-input')) return;
    const ta = inputs[i];
    if (!(ta instanceof HTMLTextAreaElement)) return;
    const inBand = zoneAt({ ...rowsOf(ta, lyr(doc.lines[i]).text), chips: [] }, e.clientY - ta.getBoundingClientRect().top).chords;
    hoverAdd = inBand ? i : hoverAdd === i ? -1 : hoverAdd;
  }

  function commitEdit() {
    if (!editing) return;
    const { line, idx, pos, value } = editing;
    editing = null;
    const l = doc.lines[line];
    let { text, chords } = lyr(l);
    const name = value.trim();
    if (idx === null) {
      if (!name) return;
      if (pos > text.length) text = text + ' '.repeat(pos - text.length);
      chords = [...chords, { pos, chord: name }];
    } else {
      chords = name ? chords.map((c, k) => (k === idx ? { ...c, chord: name } : c)) : chords.filter((_, k) => k !== idx);
    }
    setLine(line, makeLine(text, chords));
  }

  /** Keep a chord being typed when the user clicks anywhere else, not only on Enter. */
  function commitOutside(e: PointerEvent) {
    if (editing && !(e.target as HTMLElement).closest?.('.chord-input')) commitEdit();
  }

  function chipDown(i: number, idx: number, e: PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    selected = { line: i, idx };
    drag = { line: i, idx, startX: e.clientX, pos: lyr(doc.lines[i]).chords[idx].pos, moved: false };
  }

  function chipMove(e: PointerEvent) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
    if (!drag.moved) return;
    // The chip is dragged in a chord band: it anchors to the letter below, on any row.
    const h = hit(drag.line, e);
    if (h) drag.pos = h.pos;
  }

  function chipUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) moveChord(d.line, d.idx, d.pos);
  }

  function moveChord(i: number, idx: number, pos: number) {
    let { text, chords } = lyr(doc.lines[i]);
    pos = Math.max(0, pos);
    if (pos > text.length) text = text + ' '.repeat(pos - text.length);
    setLine(i, makeLine(text, chords.map((c, k) => (k === idx ? { ...c, pos } : c))));
  }

  function chipKey(i: number, idx: number, e: KeyboardEvent) {
    const c = lyr(doc.lines[i]).chords[idx];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveChord(i, idx, c.pos + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const l = lyr(doc.lines[i]);
      setLine(i, makeLine(l.text, l.chords.filter((_, k) => k !== idx)));
      selected = null;
      focusLine(i, c.pos);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      editing = { line: i, idx, pos: c.pos, value: c.chord, ...(geo[i]?.chips[idx] ?? chordFieldAt(i, c.pos)) };
    } else if (e.key === 'Escape') {
      selected = null;
      focusLine(i, c.pos);
    }
  }

  function autofocus(el: HTMLInputElement) {
    el.focus();
    el.select();
  }
</script>

<svelte:document onpointerdowncapture={commitOutside} oncopy={onCopy} oncut={onCut} onpaste={onPaste} />

<div class="toolbar" role="toolbar" aria-label={t('sec.toolbar')}>
  <span class="group">
    {#each ['chorus', 'verse', 'bridge'] as env (env)}
      {@const active = range ? selEnv === env : currentEnv === env}
      <button
        class:active
        class="tinted"
        style:--k="var(--{env})"
        title={range ? t(active ? 'sel.unwrapHelp' : 'sel.wrapHelp', { name: t(ENV_LABEL[env]) }) : t(active ? 'sec.unwrapHelp' : 'sec.wrapHelp', { name: t(ENV_LABEL[env]) })}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => (range ? wrapSel(env) : toggleSection(env))}>{t(ENV_LABEL[env])}</button
      >
    {/each}
  </span>
  <span class="group">
    <button class="tinted" style:--k="var(--chorus)" title={t('sec.repeatHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => insertAfter({ kind: 'directive', name: 'chorus', value: '' })}>↻ {t('sec.repeat')}</button>
    <button class="tinted" style:--k="var(--note)" title={t('sec.noteHelp')} onmousedown={(e) => e.preventDefault()} onclick={insertNote}>✎ {t('sec.note')}</button>
  </span>
  <span class="group">
    <button class="tinted" style:--k="var(--break)" title={range ? t('sel.beforeHelp') : t('sec.colbHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => (range ? breakSel(false, 'before') : insertBreak(false))}>⇥ {t('sec.colb')}</button>
    <button class="tinted" style:--k="var(--break)" title={range ? t('sel.beforeHelp') : t('sec.pageHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => (range ? breakSel(true, 'before') : insertBreak(true))}>⤓ {t('sec.page')}</button>
  </span>
  <span class="group">
    <button class:active={selectMode || !!sel} title={t('sel.modeHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => (selectMode || sel ? clearSel() : (selectMode = true))}>{t('sel.mode')}</button>
  </span>
  {#if range}
    <span class="group selection-tools">
      <span class="count">{t('sel.count', { n: range[1] - range[0] + 1 })}</span>
      <button class="tinted" style:--k="var(--break)" title={t('sel.colbAfterHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => breakSel(false, 'after')}>⇥ {t('sel.colbAfter')}</button>
      <button class="tinted" style:--k="var(--break)" title={t('sel.pageAfterHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => breakSel(true, 'after')}>⤓ {t('sel.pageAfter')}</button>
      <button onmousedown={(e) => e.preventDefault()} onclick={async () => { await writeClipboard(linesToText(selLines())); deleteSel(); }}>{t('sel.cut')}</button>
      <button onmousedown={(e) => e.preventDefault()} onclick={() => writeClipboard(linesToText(selLines()))}>{t('sel.copy')}</button>
      <button onmousedown={(e) => e.preventDefault()} onclick={deleteSel}>{t('sel.delete')}</button>
    </span>
  {/if}
</div>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
<div class="editor" class:selecting={selectMode} bind:this={editorEl} tabindex="-1" onkeydown={editorKey}>
  <div class="mirror" bind:this={mirror} aria-hidden="true"></div>
  {#each doc.lines as l, i (i)}
    {#if !(l.kind === 'directive' && META.has(l.name))}
      {@const v = lyr(l)}
      {@const m = markerOf(l)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
      <div
        class="line {l.kind} env-{envs[i] || 'none'}"
        class:env={envs[i]}
        class:current={cursor === i}
        class:selected={inRange(i)}
        onfocusin={() => (cursor = i)}
        onpointerdowncapture={(e) => linePointer(i, e)}
        onmousedowncapture={(e) => linePointer(i, e)}
      >
        {#if m && l.kind === 'directive'}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="marker {m.type} {m.type === 'start' || m.type === 'end' ? 'env-' + m.env : ''}"
            tabindex={m.type === 'end' || m.type === 'break' ? 0 : -1}
            role="group"
            bind:this={inputs[i]}
            onkeydown={(e) => markerKey(i, e)}
          >
            {#if m.type === 'start'}
              <span class="tag">{t(ENV_LABEL[m.env])}</span>
              <input class="label" value={l.value} placeholder={t('sec.labelPlaceholder')} oninput={(e) => setValue(i, e.currentTarget.value)} />
            {:else if m.type === 'end'}
              <span class="tag end">{t('sec.end', { name: t(ENV_LABEL[m.env]) })}</span>
            {:else if m.type === 'repeat'}
              <span class="tag">↻ {t('sec.repeat')}</span>
              <input class="label" value={l.value} placeholder={chorusHint(i) || t('sec.labelPlaceholder')} oninput={(e) => setValue(i, e.currentTarget.value)} />
            {:else if m.type === 'break'}
              <span class="tag">{m.page ? '⤓ ' + t('sec.page') : '⇥ ' + t('sec.colb')}</span>
              <span class="rule"></span>
            {:else}
              <span class="tag">✎ {t('sec.note')}</span>
              <input class="note" value={l.value} placeholder={t('sec.notePlaceholder')} oninput={(e) => setValue(i, e.currentTarget.value)} />
            {/if}
            <button class="remove" title={t('book.remove')} onclick={() => removeMarker(i)}>✕</button>
          </div>
        {:else if l.kind === 'lyrics' || l.kind === 'empty'}
          {@const g = geo[i]}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="lyric" class:adding={hoverAdd === i} onpointerdown={(e) => lyricDown(i, e)} onpointermove={(e) => lyricHover(i, e)} onpointerleave={() => hoverAdd === i && (hoverAdd = -1)}>
            {#each v.chords as c, idx (idx)}
              {@const pt = g?.chips[idx]}
              <button
                class="chip"
                class:selected={selected?.line === i && selected?.idx === idx}
                class:dragging={drag?.line === i && drag?.idx === idx && drag.moved}
                class:unplaced={!pt}
                style="left: {pt?.x ?? 0}px; top: {pt?.y ?? 0}px"
                onpointerdown={(e) => chipDown(i, idx, e)}
                onpointermove={chipMove}
                onpointerup={chipUp}
                ondblclick={() => (editing = { line: i, idx, pos: c.pos, value: c.chord, ...(pt ?? chordFieldAt(i, c.pos)) })}
                onkeydown={(e) => chipKey(i, idx, e)}
                onblur={() => selected?.line === i && selected?.idx === idx && (selected = null)}
              >{c.chord}</button>
            {/each}
            {#if editing && editing.line === i}
              <input
                class="chord-input"
                style="left: {editing.x}px; top: {editing.y}px"
                bind:value={editing.value}
                use:autofocus
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    commitEdit();
                    focusLine(i, editing?.pos ?? 0);
                  } else if (e.key === 'Escape') editing = null;
                }}
                onblur={commitEdit}
                placeholder="Am"
                size="5"
              />
            {/if}
            <textarea
              class="text"
              rows={g?.rows ?? 1}
              bind:this={inputs[i]}
              value={v.text}
              oninput={(e) => onInput(i, e)}
              onkeydown={(e) => onKeydown(i, e)}
              onpaste={(e) => fieldPaste(i, e)}
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
            ></textarea>
          </div>
        {:else if !m}
          <textarea
            class="text"
            rows="1"
            wrap="off"
            bind:this={inputs[i]}
            value={v.text}
            oninput={(e) => onInput(i, e)}
            onkeydown={(e) => onKeydown(i, e)}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          ></textarea>
        {/if}
      </div>
    {/if}
  {/each}
  <button class="add-line" onclick={() => { update([...doc.lines, { kind: 'empty' }]); focusLine(doc.lines.length, 0); }}>{t('song.addLine')}</button>
</div>

<style>
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 16px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .toolbar .group {
    display: inline-flex;
    gap: 4px;
  }
  .toolbar button {
    border-radius: 5px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .marker {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: var(--muted);
    padding: 3px 0;
    outline: none;
  }
  .marker:focus-visible,
  .marker:focus-within {
    color: var(--fg);
  }
  .marker .tag {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    white-space: nowrap;
  }
  /* Marker labels take the hue of their kind, like the toolbar buttons. */
  .marker.env-chorus .tag,
  .marker.repeat .tag {
    color: var(--chorus);
  }
  .marker.env-verse .tag {
    color: var(--verse);
  }
  .marker.env-bridge .tag {
    color: var(--bridge);
  }
  .marker.note .tag {
    color: var(--note);
  }
  .marker.break .tag {
    color: var(--break);
  }
  .marker .tag.end {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .marker input {
    font: inherit;
    border: 1px solid transparent;
    background: transparent;
    color: var(--fg);
    padding: 1px 4px;
    border-radius: 3px;
    min-width: 0;
  }
  .marker input:hover,
  .marker input:focus {
    border-color: var(--line);
    outline: none;
  }
  .marker .label {
    width: 14em;
  }
  .marker .note {
    flex: 1;
    font: italic 15px 'LiberationSerif-Italic', 'Times New Roman', serif;
  }
  .marker .rule {
    flex: 1;
    border-top: 1px dashed var(--muted);
  }
  .marker .remove {
    margin-left: auto;
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
    padding: 0 4px;
  }
  .line:hover .remove,
  .marker:focus-within .remove,
  .marker:focus .remove {
    opacity: 1;
  }
  @media (hover: none) {
    .marker .remove {
      opacity: 1;
    }
  }
  .editor {
    position: relative;
    font: 16px 'LiberationSerif-Regular', 'Times New Roman', serif;
    padding: 12px 16px 40px;
  }
  .line {
    position: relative;
    padding-left: 6px;
    border-left: 3px solid transparent;
  }
  .line.env {
    margin-left: 14px;
  }
  .line.env-chorus {
    border-left-color: var(--chorus);
  }
  .line.env-verse {
    border-left-color: var(--verse);
  }
  .line.env-bridge {
    border-left-color: var(--bridge);
  }
  /* A lyrics line: chords are drawn in the room the tall rows leave above each row of text. */
  .lyric {
    position: relative;
    padding-top: 4px;
  }
  .lyric.adding,
  .lyric.adding .text {
    cursor: copy;
  }
  /* Hidden copy of a field, to find where the browser wraps the text and places each letter. */
  .mirror {
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
  }
  .chip,
  .chord-input {
    position: absolute;
    z-index: 1;
    font: bold 13px 'LiberationSerif-Bold', 'Times New Roman', serif;
    line-height: 16px;
    padding: 0 2px;
    margin-left: -2px;
    border-radius: 3px;
  }
  .chip {
    border: none;
    background: transparent;
    color: var(--chord);
    cursor: grab;
  }
  .chip:hover {
    background: var(--chip-hover);
  }
  .chip.selected,
  .chip:focus-visible {
    background: var(--accent);
    color: var(--on-accent);
    outline: none;
  }
  .chip.unplaced {
    visibility: hidden;
  }
  .chip.dragging {
    cursor: grabbing;
    opacity: 0.8;
  }
  .chord-input {
    z-index: 2;
    border: 1px solid var(--accent);
    background: var(--bg);
    color: var(--fg);
    width: 5em;
  }
  .text {
    display: block;
    width: 100%;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    line-height: 20px;
    background: transparent;
    color: var(--fg);
    outline: none;
    resize: none;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
  }
  .lyric .text {
    line-height: 34px;
  }
  .line.empty .lyric .text {
    line-height: 22px;
  }
  .line.empty:hover .lyric .text,
  .line.empty:focus-within .lyric .text {
    line-height: 34px;
  }
  .editor:focus {
    outline: none;
  }
  /* Phones: the section toolbar is one row that scrolls sideways. */
  @container main (max-width: 600px) {
    .toolbar {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      gap: 8px;
      padding: 6px 12px;
    }
    .toolbar::-webkit-scrollbar {
      display: none;
    }
    .toolbar .group {
      flex: none;
    }
    .toolbar button {
      white-space: nowrap;
    }
    .editor {
      padding: 8px 12px 40px;
    }
  }
  .line.selected,
  .line.selected:focus-within {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  /* Selecting on a touch screen: taps go to the lines, not into their fields. */
  .editor.selecting .text,
  .editor.selecting .chip,
  .editor.selecting .marker input {
    pointer-events: none;
  }
  .selection-tools .count {
    align-self: center;
    font-weight: 600;
    color: var(--accent);
  }
  .toolbar button:not(.tinted).active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .line:focus-within {
    background: var(--line-focus);
  }
  .line.directive .text,
  .line.comment .text {
    font: 13px ui-monospace, Menlo, monospace;
    color: var(--muted);
  }
  .line.directive {
    margin-top: 4px;
  }
  .add-line {
    margin-top: 8px;
    background: none;
    border: 1px dashed var(--line);
    color: var(--muted);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
  }
</style>
