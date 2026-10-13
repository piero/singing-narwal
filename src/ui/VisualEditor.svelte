<script lang="ts" module>
  /** Metadata directives, edited in the form above the editor rather than inline. */
  export const META = new Set(['title', 'subtitle', 'artist', 'key', 'columns', 'capo', 'tempo', 'time', 'album', 'year', 'composer', 'lyricist', 'copyright']);
</script>

<script lang="ts">
  // Hybrid song editor: one text field per line, with the chords drawn above the
  // letters they are anchored to.
  //
  // - Type lyrics as usual: chords stay attached to their letters.
  // - Click above a letter to add a chord; type "[Am]" inline works too.
  // - Drag a chord, or select it and use ←/→, to anchor it to another letter.
  // - Double-click (or Enter on) a chord to rename it; Delete removes it.
  // - Lines starting with "{" are ChordPro directives, e.g. {start_of_chorus}.
  import { tick } from 'svelte';
  import { t } from './i18n.svelte';
  import { parseLyricsLine, parseSong, serializeLine, type ChordAnchor, type SongDoc, type SongLine } from '../core/chordpro';

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

  /** Chip positions: above their letter, pushed right when they would overlap. */
  function chipXs(text: string, chords: ChordAnchor[], posOf: (idx: number) => number): number[] {
    void fontEpoch;
    const order = chords.map((_, k) => k).sort((a, b) => posOf(a) - posOf(b));
    const xs: number[] = [];
    let end = -Infinity;
    for (const k of order) {
      const pos = posOf(k);
      const x = Math.max(xAt(text + ' '.repeat(Math.max(0, pos - text.length)), pos), end);
      ctx.font = CHIP_FONT;
      end = x + ctx.measureText(chords[k].chord).width + 6;
      xs[k] = x;
    }
    return xs;
  }

  /** Character boundary nearest to x (may be past the end of the text). */
  function posAt(text: string, x: number): number {
    ctx.font = FONT;
    let prev = 0;
    for (let i = 1; i <= text.length; i++) {
      const w = ctx.measureText(text.slice(0, i)).width;
      if (w > x) return x - prev < w - x ? i - 1 : i;
      prev = w;
    }
    const space = ctx.measureText(' ').width;
    return text.length + Math.max(0, Math.round((x - prev) / space));
  }

  let inputs: HTMLInputElement[] = $state([]);
  let selected: { line: number; idx: number } | null = $state(null);
  let editing: { line: number; idx: number | null; pos: number; value: string } | null = $state(null);
  let drag: { line: number; idx: number; startX: number; pos: number; moved: boolean } | null = $state(null);

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
    const input = e.currentTarget as HTMLInputElement;
    const old = lyr(doc.lines[i]);
    const isRaw = doc.lines[i].kind === 'directive' || doc.lines[i].kind === 'comment';
    let value = input.value;
    let caret = input.selectionStart ?? value.length;
    let chords = isRaw ? [] : shiftChords(old.text, value, old.chords);
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
      inputs[i]?.setSelectionRange(caret, caret);
    }
  }

  async function focusLine(i: number, caret: number) {
    await tick();
    const el = inputs[i];
    if (!el) return;
    el.focus();
    const c = Math.min(caret, el.value.length);
    el.setSelectionRange(c, c);
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
    const input = e.currentTarget as HTMLInputElement;
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
      const j = visibleNeighbour(i, e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0) return;
      e.preventDefault();
      const x = xAt(input.value, caret);
      focusLine(j, posAt(lyr(doc.lines[j]).text, x));
    }
  }

  // --- Chords -------------------------------------------------------------

  function rowX(e: PointerEvent | MouseEvent, row: HTMLElement) {
    return e.clientX - row.getBoundingClientRect().left;
  }

  function startAdd(i: number, e: PointerEvent) {
    if (e.target !== e.currentTarget) return;
    // Keep the browser from moving focus away from the chord field we open.
    e.preventDefault();
    const l = doc.lines[i];
    if (l.kind !== 'lyrics' && l.kind !== 'empty') return;
    const pos = posAt(lyr(l).text, rowX(e, e.currentTarget as HTMLElement));
    editing = { line: i, idx: null, pos, value: '' };
    selected = null;
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

  function chipDown(i: number, idx: number, e: PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    selected = { line: i, idx };
    drag = { line: i, idx, startX: e.clientX, pos: lyr(doc.lines[i]).chords[idx].pos, moved: false };
  }

  function chipMove(e: PointerEvent) {
    if (!drag) return;
    const row = (e.currentTarget as HTMLElement).parentElement!;
    if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
    if (drag.moved) drag.pos = posAt(lyr(doc.lines[drag.line]).text, rowX(e, row));
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
      editing = { line: i, idx, pos: c.pos, value: c.chord };
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

<div class="editor">
  {#each doc.lines as l, i (i)}
    {#if !(l.kind === 'directive' && META.has(l.name))}
      {@const v = lyr(l)}
      <div
        class="line {l.kind} env-{envs[i] || 'none'}"
        class:env={envs[i]}
      >
        {#if l.kind === 'lyrics' || l.kind === 'empty'}
          {@const xs = chipXs(v.text, v.chords, (k) => (drag && drag.line === i && drag.idx === k ? drag.pos : v.chords[k].pos))}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="chordrow" onpointerdown={(e) => startAdd(i, e)} onmousedown={(e) => e.target === e.currentTarget && e.preventDefault()} title={t('song.addChord')}>
            {#each v.chords as c, idx (idx)}
              <button
                class="chip"
                class:selected={selected?.line === i && selected?.idx === idx}
                class:dragging={drag?.line === i && drag?.idx === idx && drag.moved}
                style="left: {xs[idx]}px"
                onpointerdown={(e) => chipDown(i, idx, e)}
                onpointermove={chipMove}
                onpointerup={chipUp}
                ondblclick={() => (editing = { line: i, idx, pos: c.pos, value: c.chord })}
                onkeydown={(e) => chipKey(i, idx, e)}
                onblur={() => selected?.line === i && selected?.idx === idx && (selected = null)}
              >{c.chord}</button>
            {/each}
            {#if editing && editing.line === i}
              <input
                class="chord-input"
                style="left: {xAt(v.text + ' '.repeat(Math.max(0, editing.pos - v.text.length)), editing.pos)}px"
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
          </div>
        {/if}
        <input
          class="text"
          bind:this={inputs[i]}
          value={v.text}
          oninput={(e) => onInput(i, e)}
          onkeydown={(e) => onKeydown(i, e)}
          spellcheck="false"
          placeholder={l.kind === 'empty' ? '' : undefined}
        />
      </div>
    {/if}
  {/each}
  <button class="add-line" onclick={() => { update([...doc.lines, { kind: 'empty' }]); focusLine(doc.lines.length, 0); }}>{t('song.addLine')}</button>
</div>

<style>
  .editor {
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
  .line.env-bridge,
  .line.env-verse {
    border-left-color: var(--line);
  }
  .chordrow {
    position: relative;
    height: 17px;
    cursor: copy;
  }
  .line.empty .chordrow {
    height: 6px;
  }
  .line.empty:hover .chordrow,
  .line.empty:focus-within .chordrow {
    height: 17px;
  }
  .chip,
  .chord-input {
    position: absolute;
    top: 0;
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
