<script lang="ts">
  import { onDestroy } from 'svelte';
  import { debouncedSaver } from './saves';
  import { getMeta, parseSong, serializeSong, setMeta, type SongDoc } from '../core/chordpro';
  import { fontFamilies, type FontRegistry } from '../core/fonts';
  import { impose, PAGE_SIZES, type PageSizeName } from '../core/impose';
  import { DEFAULT_STYLE, layoutSong, withFont, type Columns } from '../core/layout';
  import { convertNotation, songNotation, transposeSong } from '../core/transform';
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
    });
  });

  // Autosave.
  /** Phones: artist, key and chord tools are folded under the title. */
  let showDetails = $state(false);
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
        throw e; // also shown by the app
      }
    });
  });

  /** Apply an edit. Typing within a short time is grouped into one undo step; `step` forces a new one. */
  function change(d: SongDoc, step = false) {
    const now = Date.now();
    const text = serializeSong(d);
    if (step || now - lastPush > 800 || !history.length) history.push(text);
    else history[history.length - 1] = text;
    lastPush = step ? 0 : now; // the next edit after a step starts a new one
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

  const notation = $derived(songNotation(doc));
  const columns = $derived((meta('columns') === '1' ? 1 : meta('columns') === '2' ? 2 : 'auto') as Columns);
  const families = $derived(fontFamilies(fonts));
  const style = $derived(withFont(DEFAULT_STYLE, fonts, songSettings.font, songSettings.fontSize || DEFAULT_STYLE.lyrics.size));
  const laid = $derived.by(() => {
    if (!doc.lines.length) return null;
    const size = PAGE_SIZES[songSettings.page];
    return layoutSong(doc, fonts, style, {
      ...size,
      columns,
      notation: 'original',
      transpose: 0,
      showChords: songSettings.showChords,
    });
  });
  const sheets = $derived(laid ? impose(laid.pages, { kind: songSettings.imposition, foldLine: true }) : []);

  async function exportPdf() {
    // pdf-lib is loaded on the first export, to keep it out of the initial download.
    const { renderPdf } = await import('../core/pdf');
    const pdf = await renderPdf(sheets, fonts, { title: laid?.title, creator: __APP_NAME__ });
    const base = path.split('/').pop()!.replace(/\.\w+$/, '');
    await saveFile(`${base}.pdf`, pdf, 'application/pdf');
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="song-view">
  <section class="edit-pane">
    <div class="meta">
      <div class="row">
        <input class="title" placeholder={t('song.title')} value={meta('title')} oninput={(e) => setM('title', e.currentTarget.value)} />
        <button class="details-toggle" aria-expanded={showDetails} title={t('song.details')} onclick={() => (showDetails = !showDetails)}>{showDetails ? '▴' : '⋯'}</button>
      </div>
      <div class="details" class:open={showDetails}>
      <div class="row">
        <input placeholder={t('song.artist')} value={meta('artist')} oninput={(e) => setM('artist', e.currentTarget.value)} />
        <input class="short" placeholder={t('song.key')} value={meta('key')} oninput={(e) => setM('key', e.currentTarget.value)} />
      </div>
      <div class="row chord-tools">
        <span class="seg" role="group" aria-label={t('opt.chords')}>
          {t('opt.chords')}
          <button class:active={notation === 'italian'} disabled={!notation} title={t('song.toItalian')} onclick={() => change(convertNotation(doc, 'italian'), true)}>Do Re Mi</button>
          <button class:active={notation === 'english'} disabled={!notation} title={t('song.toEnglish')} onclick={() => change(convertNotation(doc, 'english'), true)}>C D E</button>
        </span>
        <span class="seg" role="group" aria-label={t('opt.transpose')}>
          {t('opt.transpose')}
          <button disabled={!notation} title={t('song.transposeDown')} onclick={() => change(transposeSong(doc, -1), true)}>−½</button>
          <button disabled={!notation} title={t('song.transposeUp')} onclick={() => change(transposeSong(doc, 1), true)}>+½</button>
        </span>
        <button
          class="toggle"
          aria-pressed={!songSettings.showChords}
          title={t('song.chordsToggleHelp')}
          onclick={() => {
            songSettings.showChords = !songSettings.showChords;
            saveSettings();
          }}>{songSettings.showChords ? t('song.hideChords') : t('song.showChords')}</button
        >
      </div>
      </div>
      <div class="row tabs">
        <button class:active={mode === 'visual'} onclick={() => (mode = 'visual')}>{t('song.editor')}</button>
        <button class:active={mode === 'source'} onclick={() => (mode = 'source')}>{t('song.source')}</button>
        <span class="status" title={location}>{status}<span class="where">{status ? ' · ' : ''}{location}</span></span>
      </div>
    </div>
    <div class="editor-scroll">
      {#if mode === 'visual'}
        <VisualEditor {doc} onchange={change} {focusRequest} />
        <p class="help">
          {t('song.help', { chordExample: '[Am]' })}
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
      <label title={t('song.columnsHelp')}>
        {t('song.columns')}
        <select value={meta('columns') || 'auto'} onchange={(e) => setM('columns', e.currentTarget.value === 'auto' ? '' : e.currentTarget.value)}>
          <option value="auto">{t('opt.auto')}</option>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
      </label>
      <label>
        {t('opt.font')}
        <select bind:value={songSettings.font} onchange={saveSettings}>
          {#each families as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      </label>
      <label>
        {t('opt.fontSize')}
        <input class="size" type="number" step="0.5" min="6" max="20" bind:value={songSettings.fontSize} onchange={saveSettings} />
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
  .meta input {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  .meta .title {
    flex: 1;
    min-width: 0;
    font-size: 20px;
    font-weight: 600;
  }
  .details {
    display: contents;
  }
  .details-toggle {
    display: none;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    border-radius: 4px;
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .row input {
    flex: 1;
    min-width: 0;
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
  .toolbar .size {
    width: 4.5em;
  }
  .info {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 16px;
  }
  .chord-tools {
    flex-wrap: wrap;
    gap: 16px;
    font-size: 13px;
    color: var(--muted);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 0;
  }
  .seg button {
    margin-left: -1px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    padding: 2px 9px;
    cursor: pointer;
  }
  .seg button:first-of-type {
    margin-left: 6px;
    border-radius: 5px 0 0 5px;
  }
  .seg button:last-of-type {
    border-radius: 0 5px 5px 0;
  }
  .toggle {
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--bg);
    color: var(--fg);
    padding: 2px 9px;
    cursor: pointer;
  }
  .seg button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  /* Narrow editor area (phones, tablets, small windows): one pane at a time, switched from the top bar. */
  @container main (max-width: 900px) {
    .song-view {
      grid-template-columns: minmax(0, 1fr);
    }
    .edit-pane {
      border-right: none;
    }
    :global(main:not([data-pane='preview'])) .preview-pane,
    :global(main[data-pane='preview']) .edit-pane {
      display: none;
    }
  }
  /* Phones: the lyrics get the room. Details fold under the title, and the whole pane
     scrolls, so the header goes away while the section toolbar stays at the top. */
  @container main (max-width: 600px) {
    .edit-pane {
      overflow-y: auto;
    }
    .editor-scroll {
      flex: none;
      overflow: visible;
    }
    .meta {
      padding: 8px 12px 0;
      gap: 6px;
    }
    .meta .title {
      font-size: 18px;
    }
    .details-toggle {
      display: block;
    }
    .details:not(.open) {
      display: none;
    }
    .status .where {
      display: none;
    }
    .source {
      min-height: 70vh;
    }
  }
</style>
