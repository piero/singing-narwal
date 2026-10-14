<script lang="ts">
  import { getMeta, parseSong } from './core/chordpro';
  import { isFontFile, type FontRegistry } from './core/fonts';
  import { slugify } from './core/import';
  import { serializePage, starterTemplate } from './core/pages';
  import { defaultSongbook, serializeSongbook } from './core/songbook';
  import { tick } from 'svelte';
  import { loadFonts } from './ui/assets.svelte';
  import { deleteFile, renameFile, renameSong, songbooksUsing } from './ui/fileops';
  import { settleSaves } from './ui/saves';
  import BookView from './ui/BookView.svelte';
  import { i18n, LANGS, setLang, t, type Lang } from './ui/i18n.svelte';
  import ImportDialog from './ui/ImportDialog.svelte';
  import PageView from './ui/PageView.svelte';
  import SongView from './ui/SongView.svelte';
  import {
    BrowserFolderWorkspace,
    DemoWorkspace,
    copyWorkspace,
    isPage,
    isSong,
    isSongbook,
    pickFolder,
    saveFile,
    tiny,
    zipWorkspace,
    type Workspace,
  } from './ui/workspace';

  let fonts = $state<FontRegistry | null>(null);
  let workspace: Workspace = $state(new DemoWorkspace());
  let files: string[] = $state([]);
  let titles: Record<string, string> = $state({});
  let current = $state<string | null>(null);
  let filter = $state('');
  let error = $state('');
  let importing = $state(false);
  let menu = $state<{ path: string; x: number; y: number } | null>(null);
  let fontKey = '';

  async function refresh() {
    files = await workspace.list();
    for (const f of files.filter(isSong)) {
      workspace.readText(f).then((text) => (titles[f] = getMeta(parseSong(text), 'title') || f.split('/').pop()!));
    }
    // Reload fonts when the workspace's font files change.
    const key = workspace.name + '|' + files.filter(isFontFile).join('|');
    if (key !== fontKey) {
      fontKey = key;
      try {
        const r = await loadFonts(workspace, files);
        fonts = r.fonts;
        error = r.errors.join('; ');
      } catch (e) {
        error = t('app.fontsError', { msg: (e as Error).message });
      }
    }
  }

  $effect(() => {
    void workspace;
    current = null;
    titles = {};
    refresh();
  });

  let notice = $state('');
  const canUseFolders = !!tiny() || BrowserFolderWorkspace.supported();
  const where = (ws: Workspace) => (ws.kind === 'browser' ? t('where.browser') : t('where.folder', { name: ws.name }));

  async function openFolder() {
    try {
      const w = await pickFolder();
      if (w) workspace = w;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  /** Copy everything into a folder on disk and continue working there. */
  async function saveAllToFolder() {
    try {
      const target = await pickFolder();
      if (!target) return;
      const existing = await target.list();
      if (existing.length && !confirm(t('ws.copyConfirm', { name: target.name, n: existing.length }))) return;
      const open = current;
      current = null;
      await tick();
      await settleSaves();
      const n = await copyWorkspace(workspace, target);
      workspace = target;
      await tick();
      current = open;
      notice = t('ws.copied', { n, name: target.name });
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
    }
  }

  async function downloadZip() {
    await settleSaves();
    await saveFile(`${workspace.name}.zip`, await zipWorkspace(workspace), 'application/zip');
  }

  async function saveCopy(path: string) {
    menu = null;
    await settleSaves();
    await saveFile(path.split('/').pop()!, await workspace.readBytes(path), 'text/plain');
  }

  function uniqueName(base: string, ext: string) {
    let name = `${base}${ext}`;
    for (let i = 2; files.includes(name); i++) name = `${base}-${i}${ext}`;
    return name;
  }

  async function newSong() {
    const title = prompt(t('prompt.songTitle'), t('prompt.songTitleDefault'));
    if (!title) return;
    const name = uniqueName(`songs/${slugify(title)}`, '.cho');
    await workspace.writeText(name, `{title: ${title}}\n\n${t('song.newLyrics')}\n`);
    await refresh();
    current = name;
  }

  async function newBook() {
    const title = prompt(t('prompt.bookTitle'), t('prompt.bookTitleDefault'));
    if (!title) return;
    const name = uniqueName(title.replace(/[/\\:]/g, '-'), '.songbook.yaml');
    const book = { ...defaultSongbook(), title, notation: (i18n.lang === 'it' ? 'italian' : 'english') as 'italian' | 'english', contents: [{ toc: t('book.indexTitle') }] };
    await workspace.writeText(name, serializeSongbook(book));
    await refresh();
    current = name;
  }

  async function newPage() {
    const title = prompt(t('prompt.pageName'), t('prompt.pageNameDefault'));
    if (!title) return;
    const name = uniqueName(`pages/${slugify(title)}`, '.page.yaml');
    await workspace.writeText(name, serializePage(starterTemplate('cover', i18n.lang)));
    await refresh();
    current = name;
  }

  const songs = $derived(
    files
      .filter(isSong)
      .filter((f) => !filter || (titles[f] ?? f).toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => (titles[a] ?? a).localeCompare(titles[b] ?? b)),
  );
  const books = $derived(files.filter(isSongbook));
  const pages = $derived(files.filter(isPage));
  const baseName = (f: string) => f.split('/').pop()!.replace(/\.(songbook|page)\.ya?ml$/i, '');
  const label = (f: string) => (isSong(f) ? (titles[f] ?? baseName(f)) : baseName(f));

  function openMenu(path: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { path, x: e.type === 'contextmenu' ? e.clientX : r.right - 4, y: e.type === 'contextmenu' ? e.clientY : r.bottom };
  }

  /**
   * Close the open editor (saving pending changes) while files change on disk,
   * then reopen what was open, following a rename.
   */
  async function withEditorsClosed(op: () => Promise<{ from: string; to: string | null }>) {
    const open = current;
    current = null;
    await tick();
    await settleSaves();
    try {
      const { from, to } = await op();
      delete titles[from];
      await refresh();
      current = open === from ? to : open;
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
      await refresh();
      current = open;
    }
  }

  async function rename(path: string) {
    menu = null;
    const old = label(path);
    const value = prompt(isSong(path) ? t('prompt.newTitle') : t('prompt.newName'), old)?.trim();
    if (!value || value === old) return;
    await withEditorsClosed(async () => ({
      from: path,
      to: isSong(path) ? await renameSong(workspace, files, path, value) : await renameFile(workspace, files, path, value),
    }));
  }

  async function remove(path: string) {
    menu = null;
    const used = await songbooksUsing(workspace, files, path);
    let msg = t('confirm.delete', { name: label(path) });
    if (used.length) msg += '\n\n' + t('confirm.deleteUsed', { books: used.map(baseName).join(', ') });
    if (!confirm(msg)) return;
    await withEditorsClosed(async () => {
      await deleteFile(workspace, files, path);
      return { from: path, to: null };
    });
  }
</script>

{#snippet item(f: string, text: string)}
  <li class:active={current === f} class:menu-open={menu?.path === f} oncontextmenu={(e) => openMenu(f, e)}>
    <button class="open" onclick={() => (current = f)} title={text}>{text}</button>
    <button class="more" title={t('menu.more')} aria-label={t('menu.more')} onclick={(e) => openMenu(f, e)}>⋯</button>
  </li>
{/snippet}

<svelte:window onclick={() => (menu = null)} onkeydown={(e) => e.key === 'Escape' && (menu = null)} />

<div class="app">
  <aside>
    <div class="ws">
      <div class="ws-name" title={t('ws.title')}>{workspace.kind === 'browser' ? '🌐' : '📁'} {workspace.name}</div>
      <p class="note" class:warn={workspace.kind === 'browser'}>
        {#if workspace.kind === 'browser'}
          {t('ws.browserNote')}
        {:else if workspace.location}
          {t('ws.folderPath', { path: workspace.location })}
        {:else}
          {t('ws.folderName', { name: workspace.name })}
        {/if}
      </p>
      <div class="ws-actions">
        {#if canUseFolders}
          <button onclick={openFolder}>{t('ws.open')}</button>
        {/if}
        <button onclick={() => (importing = true)} disabled={!fonts}>{t('side.import')}</button>
      </div>
      <div class="ws-actions">
        {#if canUseFolders}
          <button onclick={saveAllToFolder} class:primary={workspace.kind === 'browser'}>{t('ws.saveToFolder')}</button>
        {/if}
        <button onclick={downloadZip}>{t('ws.zip')}</button>
      </div>
      {#if notice}<p class="note ok">{notice}</p>{/if}
    </div>

    <h3>{t('side.songbooks')} <button class="add" onclick={newBook} title={t('side.newSongbook')}>+</button></h3>
    <ul>
      {#each books as f (f)}{@render item(f, '📖 ' + baseName(f))}{/each}
    </ul>

    <h3>{t('side.pages')} <button class="add" onclick={newPage} title={t('side.newPage')}>+</button></h3>
    <ul>
      {#each pages as f (f)}{@render item(f, '📄 ' + baseName(f))}{/each}
    </ul>

    <h3>{t('side.songs')} <button class="add" onclick={newSong} title={t('side.newSong')}>+</button></h3>
    <input class="filter" placeholder={t('side.search')} bind:value={filter} />
    <ul class="songs">
      {#each songs as f (f)}{@render item(f, titles[f] ?? baseName(f))}{/each}
    </ul>

    <label class="lang">
      {t('side.language')}
      <select value={i18n.lang} onchange={(e) => setLang(e.currentTarget.value as Lang)}>
        {#each LANGS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
    </label>
  </aside>

  <main>
    {#if error}<div class="error">{error}</div>{/if}
    {#if !fonts}
      <div class="empty">{t('app.loading')}</div>
    {:else if current && isSong(current)}
      {#key current}
        <SongView {workspace} path={current} {fonts} onsaved={refresh} location={t('file.where', { path: current, where: where(workspace) })} />
      {/key}
    {:else if current && isSongbook(current)}
      {#key current}
        <BookView {workspace} path={current} {fonts} {files} onopen={(p) => (current = p)} onfileschanged={refresh} />
      {/key}
    {:else if current && isPage(current)}
      {#key current}
        <PageView {workspace} path={current} {fonts} {files} />
      {/key}
    {:else}
      <div class="empty">
        <h1>Narwal Score</h1>
        <p>{t('app.tagline')}</p>
        <p>{t('app.pick')}</p>
      </div>
    {/if}
  </main>
</div>

{#if menu}
  {@const m = menu}
  <div class="menu" role="menu" style="left: {m.x}px; top: {m.y}px">
    <button role="menuitem" onclick={() => rename(m.path)}>{t('menu.rename')}</button>
    <button role="menuitem" onclick={() => saveCopy(m.path)}>{t('menu.saveAs')}</button>
    <button role="menuitem" class="danger" onclick={() => remove(m.path)}>{t('menu.delete')}</button>
  </div>
{/if}

{#if importing && fonts}
  <ImportDialog
    {workspace}
    {fonts}
    {files}
    onclose={async (opened) => {
      importing = false;
      await refresh();
      if (opened) current = opened;
    }}
  />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: 270px 1fr;
    height: 100vh;
  }
  aside {
    border-right: 1px solid var(--line);
    background: var(--sidebar);
    overflow: auto;
    padding: 12px;
    font-size: 14px;
    display: flex;
    flex-direction: column;
  }
  .ws {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ws-name {
    font-weight: 600;
  }
  .ws-actions {
    display: flex;
    gap: 6px;
  }
  .ws-actions button {
    flex: 1;
  }
  .note {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
    line-height: 1.35;
  }
  .note.warn {
    color: #b06000;
  }
  .note.ok {
    color: #1e8e3e;
  }
  .ws-actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 18px 0 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h3 .add {
    border: none;
    background: none;
    font-size: 16px;
    cursor: pointer;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .songs {
    flex: 1;
  }
  li {
    display: flex;
    align-items: center;
    border-radius: 5px;
  }
  li:hover,
  li.menu-open {
    background: var(--chip-hover);
  }
  li.active {
    background: var(--accent);
  }
  li button {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--fg);
    font: inherit;
  }
  li.active button {
    color: var(--on-accent);
  }
  .open {
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 4px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .more {
    padding: 2px 8px;
    opacity: 0;
    font-size: 16px;
    line-height: 1;
  }
  li:hover .more,
  li.active .more,
  li.menu-open .more,
  .more:focus-visible {
    opacity: 1;
  }
  .menu {
    position: fixed;
    z-index: 20;
    min-width: 140px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    padding: 4px;
    display: flex;
    flex-direction: column;
    transform: translateX(-100%);
  }
  .menu button {
    text-align: left;
    border: none;
    background: none;
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--fg);
    font: inherit;
  }
  .menu button:hover {
    background: var(--chip-hover);
  }
  .menu .danger {
    color: #d93025;
  }
  .filter {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 6px;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  .lang {
    margin-top: 16px;
    font-size: 12px;
    color: var(--muted);
  }
  .lang select {
    font: inherit;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 4px;
  }
  main {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .empty {
    padding: 48px;
    color: var(--muted);
  }
  .empty h1 {
    color: var(--fg);
  }
  .error {
    background: #fde7e9;
    color: #b3261e;
    padding: 8px 16px;
  }
</style>
