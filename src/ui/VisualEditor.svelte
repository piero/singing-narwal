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
  // - Sections (chorus, verse, bridge), chorus repeats, breaks and notes are added
  //   from the toolbar and shown as markers; in the file they are ChordPro
  //   directives such as {start_of_chorus}. Other directives can be typed as "{…}".
  import { tick } from 'svelte';
  import { t, type Key } from './i18n.svelte';
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

  /** Focusable element of each line: the text field, or the marker. */
  let inputs: HTMLElement[] = $state([]);
  /** Line holding the cursor, target of the toolbar actions. */
  let cursor = $state(0);
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
      (inputs[i] as HTMLInputElement | undefined)?.setSelectionRange(caret, caret);
    }
  }

  async function focusLine(i: number, caret: number) {
    await tick();
    const el = inputs[i];
    if (!el) return;
    // Markers with a field (label, note) focus the field.
    const field = el instanceof HTMLInputElement ? el : el.querySelector('input');
    (field ?? el).focus();
    if (el instanceof HTMLInputElement) {
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
      focusLine(j, 0);
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

<svelte:document onpointerdowncapture={commitOutside} />

<div class="toolbar" role="toolbar" aria-label={t('sec.toolbar')}>
  <span class="group">
    {#each ['chorus', 'verse', 'bridge'] as env (env)}
      <button class:active={currentEnv === env} class="tinted" style:--k="var(--{env})" title={t(currentEnv === env ? 'sec.unwrapHelp' : 'sec.wrapHelp', { name: t(ENV_LABEL[env]) })} onmousedown={(e) => e.preventDefault()} onclick={() => toggleSection(env)}>{t(ENV_LABEL[env])}</button>
    {/each}
  </span>
  <span class="group">
    <button class="tinted" style:--k="var(--chorus)" title={t('sec.repeatHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => insertAfter({ kind: 'directive', name: 'chorus', value: '' })}>↻ {t('sec.repeat')}</button>
    <button class="tinted" style:--k="var(--note)" title={t('sec.noteHelp')} onmousedown={(e) => e.preventDefault()} onclick={insertNote}>✎ {t('sec.note')}</button>
  </span>
  <span class="group">
    <button class="tinted" style:--k="var(--break)" title={t('sec.colbHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => insertBreak(false)}>⇥ {t('sec.colb')}</button>
    <button class="tinted" style:--k="var(--break)" title={t('sec.pageHelp')} onmousedown={(e) => e.preventDefault()} onclick={() => insertBreak(true)}>⤓ {t('sec.page')}</button>
  </span>
</div>

<div class="editor">
  {#each doc.lines as l, i (i)}
    {#if !(l.kind === 'directive' && META.has(l.name))}
      {@const v = lyr(l)}
      {@const m = markerOf(l)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
      <div
        class="line {l.kind} env-{envs[i] || 'none'}"
        class:env={envs[i]}
        class:current={cursor === i}
        onfocusin={() => (cursor = i)}
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
        {#if !(m && l.kind === 'directive')}
        <input
          class="text"
          bind:this={inputs[i]}
          value={v.text}
          oninput={(e) => onInput(i, e)}
          onkeydown={(e) => onKeydown(i, e)}
          spellcheck="false"
          placeholder={l.kind === 'empty' ? '' : undefined}
        />
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
  .line.env-verse {
    border-left-color: var(--verse);
  }
  .line.env-bridge {
    border-left-color: var(--bridge);
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
