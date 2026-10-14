<script lang="ts">
  import { onDestroy } from 'svelte';
  import { debouncedSaver } from './saves';
  import { getMeta, parseSong } from '../core/chordpro';
  import type { FontRegistry } from '../core/fonts';
  import { impose, PAGE_SIZES } from '../core/impose';
  import { renderPdf } from '../core/pdf';
  import { buildSongbook, parseSongbook, serializeSongbook, type BuiltBook, type ContentItem, type Songbook } from '../core/songbook';
  import { serializePage, starterTemplate, type TemplateName } from '../core/pages';
  import { ImageUrls } from './assets.svelte';
  import { i18n, t, type Key } from './i18n.svelte';
  import Preview from './Preview.svelte';
  import { importImage, isImage, isPage, isSong, saveFile, type Workspace } from './workspace';

  let {
    workspace,
    path,
    fonts,
    files,
    onopen,
    onfileschanged,
  }: { workspace: Workspace; path: string; fonts: FontRegistry; files: string[]; onopen: (path: string) => void; onfileschanged: () => void } = $props();

  let book = $state<Songbook | null>(null);
  let loadedPath = '';
  let savedText = '';
  let built = $state<BuiltBook | null>(null);
  let view: 'sheets' | 'pages' = $state('sheets');
  let titles: Record<string, string> = $state({});
  let status = $state('');

  // Paths in the songbook are relative to the songbook file.
  const dir = $derived(path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
  const rel = (p: string) => (dir && p.startsWith(dir) ? p.slice(dir.length) : dir ? '../'.repeat(dir.split('/').length - 1) + p : p);
  const abs = (p: string) => {
    const parts = (dir + p).split('/');
    const out: string[] = [];
    for (const part of parts) part === '..' ? out.pop() : out.push(part);
    return out.join('/');
  };
  const loader = $derived({
    readText: (p: string) => workspace.readText(abs(p)),
    readBytes: (p: string) => workspace.readBytes(abs(p)),
  });

  $effect(() => {
    const p = path;
    workspace.readText(p).then((t) => {
      loadedPath = p;
      book = parseSongbook(t);
      savedText = serializeSongbook(book);
    });
  });

  // Song titles for the lists.
  $effect(() => {
    for (const f of files.filter(isSong)) {
      if (titles[f]) continue;
      workspace.readText(f).then((t) => (titles[f] = getMeta(parseSong(t), 'title') || f.split('/').pop()!));
    }
  });

  // Rebuild and autosave after changes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saver = debouncedSaver(300);
  onDestroy(() => {
    clearTimeout(timer);
    saver.flush();
  });
  $effect(() => {
    if (!book) return;
    const text = serializeSongbook(book);
    const snapshot = $state.snapshot(book) as Songbook;
    void files; // rebuild when songs are edited
    clearTimeout(timer);
    timer = setTimeout(async () => (built = await buildSongbook(snapshot, fonts, loader)), 300);
    if (loadedPath === path && text !== savedText) {
      const target = loadedPath;
      saver.schedule(async () => {
        await workspace.writeText(target, text);
        savedText = text;
        status = t('song.saved');
      });
    }
  });

  const sheets = $derived(built ? (view === 'sheets' ? built.sheets : impose(built.pages, { kind: 'single' })) : []);

  function move(i: number, d: number) {
    if (!book) return;
    const c = book.contents;
    const j = i + d;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
  }
  function remove(i: number) {
    book?.contents.splice(i, 1);
  }
  function add(item: ContentItem) {
    book?.contents.push(item);
  }

  const images = new ImageUrls((p) => workspace.readBytes(abs(p)));

  let addSong = $state('');
  let addImage = $state('');
  let addPage = $state('');
  const TEMPLATES: { name: TemplateName; label: Key }[] = [
    { name: 'cover', label: 'tpl.cover' },
    { name: 'quote', label: 'tpl.quote' },
    { name: 'notes', label: 'tpl.notes' },
    { name: 'lines', label: 'tpl.lines' },
    { name: 'empty', label: 'tpl.empty' },
  ];

  /** Add an existing page, or create a new one from a starter template ("new:cover"). */
  async function addPageItem(choice: string) {
    if (!choice) return;
    let file = choice;
    if (choice.startsWith('new:')) {
      const name = choice.slice(4) as TemplateName;
      const base = `pages/${t(TEMPLATES.find((x) => x.name === name)!.label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      file = `${base}.page.yaml`;
      for (let n = 2; files.includes(file); n++) file = `${base}-${n}.page.yaml`;
      await workspace.writeText(file, serializePage(starterTemplate(name, i18n.lang)));
      onfileschanged();
    }
    add({ page: rel(file) });
  }
  const included = $derived(new Set(book?.contents.flatMap((c) => (typeof c === 'object' && 'song' in c ? [abs(c.song)] : [])) ?? []));

  function itemLabel(c: ContentItem): string {
    if (c === 'blank') return t('book.blank');
    if ('song' in c) return titles[abs(c.song)] ?? c.song;
    if ('image' in c) return t('book.image', { src: c.image });
    if ('page' in c) return c.page.split('/').pop()!.replace(/\.page\.ya?ml$/i, '');
    return `${t('book.index')} ${c.toc}`;
  }
  function firstPage(c: ContentItem): number | undefined {
    if (typeof c !== 'object' || !('song' in c) || !built) return undefined;
    return built.index.find((e) => e.title === titles[abs(c.song)])?.page;
  }

  async function exportPdf() {
    if (!built || !book) return;
    const pdf = await renderPdf(built.sheets, fonts, { title: book.title, creator: __APP_NAME__, loadImage: loader.readBytes });
    await saveFile(`${path.split('/').pop()!.replace(/\.songbook\.ya?ml$/i, '')}.pdf`, pdf, 'application/pdf');
  }
</script>

{#if book}
  <div class="book-view">
    <section class="edit-pane">
      <div class="form">
        <input class="title" placeholder={t('book.title')} bind:value={book.title} />
        <div class="grid">
          <label>{t('opt.page')} <select bind:value={book.page}>{#each Object.keys(PAGE_SIZES) as p (p)}<option value={p}>{p}</option>{/each}</select></label>
          <label>
            {t('opt.print')}
            <select bind:value={book.imposition}>
              <option value="booklet">{t('opt.booklet')}</option>
              <option value="2up">{t('opt.2up')}</option>
              <option value="single">{t('opt.single')}</option>
              <option value="copies">{t('opt.copies')}</option>
            </select>
          </label>
          <label title={t('book.notationHelp')}>{t('opt.chords')} <select bind:value={book.notation}><option value="original">{t('book.asWritten')}</option><option value="italian">{t('book.allItalian')}</option><option value="english">{t('book.allEnglish')}</option></select></label>
          <label>{t('song.columns')} <select bind:value={book.columns}><option value="auto">{t('opt.auto')}</option><option value={1}>1</option><option value={2}>2</option></select></label>
          <label><input type="checkbox" bind:checked={book.showChords} /> {t('book.showChords')}</label>
          <label><input type="checkbox" bind:checked={book.pageNumbers} /> {t('book.pageNumbers')}</label>
          <label><input type="checkbox" bind:checked={book.keepSpreads} /> {t('book.keepSpreads')}</label>
          <label><input type="checkbox" bind:checked={book.foldLine} /> {t('book.foldLine')}</label>
          <label>{t('book.lyricsSize')} <input type="number" step="0.5" min="6" max="20" bind:value={book.style.lyrics.size} /></label>
          <label>{t('book.chordsSize')} <input type="number" step="0.5" min="6" max="20" bind:value={book.style.chords.size} /></label>
        </div>
      </div>

      <ol class="contents">
        {#each book.contents as c, i (i)}
          <li>
            <span class="page">{firstPage(c) ?? ''}</span>
            <span class="label">
              {#if typeof c === 'object' && 'song' in c}
                <button class="link" onclick={() => onopen(abs(c.song))}>{itemLabel(c)}</button>
              {:else if typeof c === 'object' && 'page' in c}
                <button class="link" onclick={() => onopen(abs(c.page))}>📄 {itemLabel(c)}</button>
                <label class="small"><input type="checkbox" bind:checked={c.page_number} /> {t('book.pageNumber')}</label>
              {:else if typeof c === 'object' && 'toc' in c}
                {t('book.index')} <input class="inline" bind:value={c.toc} />
              {:else}
                {itemLabel(c)}
              {/if}
            </span>
            {#if typeof c === 'object' && 'song' in c}
              <span class="opts">
                <select title="Columns" value={c.columns ?? ''} onchange={(e) => (c.columns = e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'auto' ? 'auto' : (Number(e.currentTarget.value) as 1 | 2))}>
                  <option value="">{t('book.colsBook')}</option>
                  <option value="auto">{t('opt.auto')}</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </span>
            {/if}
            <span class="actions">
              <button title={t('book.moveUp')} onclick={() => move(i, -1)}>↑</button>
              <button title={t('book.moveDown')} onclick={() => move(i, 1)}>↓</button>
              <button title={t('book.remove')} onclick={() => remove(i)}>✕</button>
            </span>
          </li>
        {/each}
      </ol>

      <div class="add">
        <select bind:value={addSong}>
          <option value="">{t('book.addSong')}</option>
          {#each files.filter((f) => isSong(f) && !included.has(f)) as f (f)}<option value={f}>{titles[f] ?? f}</option>{/each}
        </select>
        <button disabled={!addSong} onclick={() => { add({ song: rel(addSong) }); addSong = ''; }}>{t('book.add')}</button>
        <button onclick={() => files.filter((f) => isSong(f) && !included.has(f)).forEach((f) => add({ song: rel(f) }))}>{t('book.addAll')}</button>
        <button onclick={() => add({ toc: t('book.indexTitle') })}>{t('book.addIndex')}</button>
        <button onclick={() => add('blank')}>{t('book.addBlank')}</button>
        <select bind:value={addPage} onchange={() => { addPageItem(addPage); addPage = ''; }}>
          <option value="">{t('book.addPage')}</option>
          {#each files.filter(isPage) as f (f)}<option value={f}>📄 {f.split('/').pop()!.replace(/\.page\.ya?ml$/i, '')}</option>{/each}
          {#each TEMPLATES as tp (tp.name)}<option value={'new:' + tp.name}>{t('book.newFromTemplate', { name: t(tp.label) })}</option>{/each}
        </select>
        <select bind:value={addImage}>
          <option value="">{t('book.addImage')}</option>
          {#each files.filter(isImage) as f (f)}<option value={f}>{f}</option>{/each}
        </select>
        <button disabled={!addImage} onclick={() => { add({ image: rel(addImage) }); addImage = ''; }}>{t('book.add')}</button>
        <button
          onclick={async () => {
            const p = await importImage(workspace, files);
            if (!p) return;
            onfileschanged();
            add({ image: rel(p) });
          }}>{t('book.imageFromComputer')}</button>
      </div>
      {#if built?.warnings.length}
        <ul class="warnings">{#each built.warnings as w (w)}<li>{w}</li>{/each}</ul>
      {/if}
    </section>

    <section class="preview-pane">
      <div class="toolbar">
        <label><input type="radio" bind:group={view} value="sheets" /> {t('book.sheets')}</label>
        <label><input type="radio" bind:group={view} value="pages" /> {t('book.pages')}</label>
        {#if built}<span class="info">{t('book.info', { pages: built.pages.length, sheets: built.sheets.length })}{book.imposition === 'booklet' ? t('book.duplex') : ''}</span>{/if}
        <span class="status">{status}</span>
        <button class="primary" onclick={exportPdf} disabled={!built}>{t('opt.exportPdf')}</button>
      </div>
      <div class="preview-scroll">
        <Preview {sheets} imageUrl={(src) => images.get(src)} />
      </div>
    </section>
  </div>
{/if}

<style>
  .book-view {
    display: grid;
    grid-template-columns: minmax(420px, 1fr) minmax(380px, 1.2fr);
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
    overflow: auto;
    padding: 12px 16px;
    gap: 12px;
  }
  .title {
    font-size: 20px;
    font-weight: 600;
    width: 100%;
    box-sizing: border-box;
  }
  input,
  select {
    font: inherit;
    padding: 3px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  input[type='number'] {
    width: 4.5em;
  }
  .grid {
    margin-top: 8px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 16px;
    font-size: 13px;
  }
  .contents {
    list-style: none;
    padding: 0;
    margin: 0;
    border-top: 1px solid var(--line);
  }
  .contents li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }
  .page {
    width: 2em;
    text-align: right;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .opts,
  .actions {
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .actions button {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--muted);
    padding: 2px 5px;
    border-radius: 3px;
  }
  .actions button:hover {
    background: var(--chip-hover);
    color: var(--fg);
  }
  .opts select {
    font-size: 12px;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .inline {
    width: 10em;
  }
  .small {
    font-size: 12px;
    color: var(--muted);
    margin-left: 8px;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .warnings {
    color: #b3261e;
    font-size: 13px;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .info,
  .status {
    color: var(--muted);
    font-size: 12px;
  }
  .toolbar .primary {
    margin-left: auto;
  }
  .preview-scroll {
    overflow: auto;
    flex: 1;
    min-height: 0;
    background: var(--canvas);
  }
</style>
