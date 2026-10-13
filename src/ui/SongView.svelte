<script lang="ts">
  import { onDestroy } from 'svelte';
  import { debouncedSaver } from './saves';
  import { getMeta, parseSong, serializeSong, setMeta, type SongDoc } from '../core/chordpro';
  import type { FontRegistry } from '../core/fonts';
  import { impose, PAGE_SIZES, type PageSizeName } from '../core/impose';
  import { DEFAULT_STYLE, layoutSong, type Columns } from '../core/layout';
  import { renderPdf } from '../core/pdf';
  import Preview from './Preview.svelte';
  import VisualEditor from './VisualEditor.svelte';
  import { saveFile, type Workspace } from './workspace';
  import { saveSettings, songSettings } from './settings.svelte';
  import { t } from './i18n.svelte';

  let {
    workspace,
    path,
    fonts,
    onsaved,
    location = '',
  }: { workspace: Workspace; path: string; fonts: FontRegistry; onsaved?: () => void; location?: string } = $props();

  let doc: SongDoc = $state({ lines: [] });
  let loadedPath = '';
  let savedText = '';
  let mode: 'visual' | 'source' = $state('visual');
  let transpose = $state(0);
  let status = $state('');
  let focusRequest: { line: number; n: number } | undefined = $state();

  // Undo history of whole-document snapshots, grouped by pauses in typing.
  let history: string[] = [];
  let future: string[] = [];
  let lastPush = 0;

  const source = $derived(serializeSong(doc));

  $effect(() => {
    const p = path;
    workspace.readText(p).then((t) => {
      loadedPath = p;
      doc = parseSong(t);
      savedText = serializeSong(doc);
      history = [savedText];
      future = [];
      transpose = 0;
    });
  });

  // Autosave.
  const saver = debouncedSaver(600);
  onDestroy(saver.flush);
  $effect(() => {
    const text = source;
    if (!loadedPath || loadedPath !== path || text === savedText) return;
    const target = loadedPath;
    saver.schedule(async () => {
      try {
        await workspace.writeText(target, text);
        savedText = text;
        status = t('song.saved');
        onsaved?.();
      } catch (e) {
        status = t('song.saveFailed', { msg: (e as Error).message });
      }
    });
  });

  function change(d: SongDoc) {
    const now = Date.now();
    const text = serializeSong(d);
    if (now - lastPush > 800 || !history.length) history.push(text);
    else history[history.length - 1] = text;
    lastPush = now;
    future = [];
    doc = d;
    status = '';
  }

  function undo() {
    if (history.length < 2) return;
    future.push(history.pop()!);
    doc = parseSong(history[history.length - 1]);
    lastPush = 0;
  }
  function redo() {
    const t = future.pop();
    if (!t) return;
    history.push(t);
    doc = parseSong(t);
    lastPush = 0;
  }

  function onKey(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    if ((e.target as HTMLElement).closest?.('.source')) return; // the textarea has its own undo
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }

  const meta = (name: string) => getMeta(doc, name) ?? '';
  const setM = (name: string, value: string) => change(setMeta(doc, name, value));

  const columns = $derived((meta('columns') === '1' ? 1 : meta('columns') === '2' ? 2 : 'auto') as Columns);
  const laid = $derived.by(() => {
    if (!doc.lines.length) return null;
    const size = PAGE_SIZES[songSettings.page];
    return layoutSong(doc, fonts, DEFAULT_STYLE, {
      ...size,
      columns,
      notation: songSettings.notation,
      transpose,
      showChords: true,
    });
  });
  const sheets = $derived(laid ? impose(laid.pages, { kind: songSettings.imposition, foldLine: true }) : []);

  async function exportPdf() {
    const pdf = await renderPdf(sheets, fonts, { title: laid?.title });
    const base = path.split('/').pop()!.replace(/\.\w+$/, '');
    await saveFile(`${base}.pdf`, pdf, 'application/pdf');
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="song-view">
  <section class="edit-pane">
    <div class="meta">
      <input class="title" placeholder={t('song.title')} value={meta('title')} oninput={(e) => setM('title', e.currentTarget.value)} />
      <div class="row">
        <input placeholder={t('song.artist')} value={meta('artist')} oninput={(e) => setM('artist', e.currentTarget.value)} />
        <input class="short" placeholder={t('song.key')} value={meta('key')} oninput={(e) => setM('key', e.currentTarget.value)} />
        <label>
          {t('song.columns')}
          <select value={meta('columns') || 'auto'} onchange={(e) => setM('columns', e.currentTarget.value === 'auto' ? '' : e.currentTarget.value)}>
            <option value="auto">{t('opt.auto')}</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </div>
      <div class="row tabs">
        <button class:active={mode === 'visual'} onclick={() => (mode = 'visual')}>{t('song.editor')}</button>
        <button class:active={mode === 'source'} onclick={() => (mode = 'source')}>{t('song.source')}</button>
        <span class="status" title={location}>{status ? status + ' · ' : ''}{location}</span>
      </div>
    </div>
    <div class="editor-scroll">
      {#if mode === 'visual'}
        <VisualEditor {doc} onchange={change} {focusRequest} />
        <p class="help">
          {t('song.help', { chordExample: '[Am]', soc: '{start_of_chorus}', eoc: '{end_of_chorus}', chorus: '{chorus}', colb: '{column_break}' })}
        </p>
      {:else}
        <textarea class="source" value={source} oninput={(e) => change(parseSong(e.currentTarget.value))} spellcheck="false"></textarea>
      {/if}
    </div>
  </section>

  <section class="preview-pane">
    <div class="toolbar">
      <label>
        {t('opt.page')}
        <select bind:value={songSettings.page} onchange={saveSettings}>
          {#each Object.keys(PAGE_SIZES) as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </label>
      <label>
        {t('opt.print')}
        <select bind:value={songSettings.imposition} onchange={saveSettings}>
          <option value="single">{t('opt.single')}</option>
          <option value="copies">{t('opt.copies')}</option>
          <option value="2up">{t('opt.2up')}</option>
        </select>
      </label>
      <label>
        {t('opt.chords')}
        <select bind:value={songSettings.notation} onchange={saveSettings}>
          <option value="italian">Do Re Mi</option>
          <option value="english">C D E</option>
        </select>
      </label>
      <label class="transpose">
        {t('opt.transpose')}
        <button onclick={() => transpose--}>−</button>
        <span>{transpose > 0 ? '+' : ''}{transpose}</span>
        <button onclick={() => transpose++}>+</button>
      </label>
      <button class="primary" onclick={exportPdf} disabled={!laid}>{t('opt.exportPdf')}</button>
    </div>
    {#if laid}
      <div class="info">
        {t('song.info', { pages: laid.pages.length, columns: laid.columns, scale: Math.round(laid.scale * 100) })}
      </div>
    {/if}
    <div class="preview-scroll">
      <Preview {sheets} onlineclick={(line) => (focusRequest = { line, n: Math.random() })} />
    </div>
  </section>
</div>

<style>
  .song-view {
    display: grid;
    grid-template-columns: minmax(380px, 1fr) minmax(380px, 1fr);
    height: 100%;
    min-height: 0;
  }
  section {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .edit-pane {
    border-right: 1px solid var(--line);
  }
  .meta {
    padding: 12px 16px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--line);
  }
  .meta input,
  .meta select {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  .meta .title {
    font-size: 20px;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .row input {
    flex: 1;
  }
  .row input.short {
    flex: 0 0 70px;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 4px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
  }
  .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .status {
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .editor-scroll,
  .preview-scroll {
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .preview-scroll {
    background: var(--canvas);
  }
  .source {
    width: 100%;
    height: 100%;
    min-height: 400px;
    border: none;
    padding: 12px 16px;
    font: 13px/1.5 ui-monospace, Menlo, monospace;
    resize: none;
    background: var(--bg);
    color: var(--fg);
    box-sizing: border-box;
  }
  .help {
    font-size: 12px;
    color: var(--muted);
    padding: 0 16px 16px;
    line-height: 1.5;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
  }
  .info {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 16px;
  }
  .transpose span {
    display: inline-block;
    min-width: 2em;
    text-align: center;
  }
</style>
