<script lang="ts">
  import { getMeta, parseSong } from './core/chordpro';
  import { isFontFile, type FontRegistry } from './core/fonts';
  import { slugify } from './core/import';
  import { serializePage, starterTemplate } from './core/pages';
  import { defaultSongbook, serializeSongbook } from './core/songbook';
  import { tick } from 'svelte';
  import { loadFonts } from './ui/assets.svelte';
  import { deleteFiles, renameFile, renameSong, songbookIndex } from './ui/fileops';
  import { onSaveError, settleSaves } from './ui/saves';
  import BookView from './ui/BookView.svelte';
  import { i18n, LANGS, setLang, t, type Lang } from './ui/i18n.svelte';
  import ImportDialog from './ui/ImportDialog.svelte';
  import PageView from './ui/PageView.svelte';
  import SongView from './ui/SongView.svelte';
  import {
    BrowserFolderWorkspace,
    BrowserWorkspace,
    NoWorkspace,
    TinyWorkspace,
    copyWorkspace,
    filesFromZip,
    isPage,
    isSong,
    isSongbook,
    pickFolder,
    pickLocalFiles,
    saveFile,
    tiny,
    readAbsoluteFiles,
    zipSongbook,
    zipWorkspace,
    type Workspace,
  } from './ui/workspace';

  let fonts = $state<FontRegistry | null>(null);
  let workspace: Workspace = $state(new NoWorkspace());
  const ready = $derived(!(workspace instanceof NoWorkspace));
  let files: string[] = $state([]);
  let titles: Record<string, string> = $state({});
  let current = $state<string | null>(null);
  let filter = $state('');
  /** For each song or page, the songbooks that include it. */
  let usedIn: Record<string, string[]> = $state({});
  /** Show only songs and pages that no songbook includes. */
  let onlyUnused = $state(false);
  /** Selection mode, to delete several songs and pages at once. */
  let selecting = $state(false);
  let selected: string[] = $state([]);
  let error = $state('');
  let importing = $state(false);
  let importDialog = $state<{ addFiles: (list: { name: string; bytes: Uint8Array }[]) => Promise<void> }>();
  /** Files opened with the desktop app from Finder or the Dock, waiting for the import dialog. */
  let opened: { name: string; bytes: Uint8Array }[] = $state([]);
  tiny()?.app.onOpenFiles?.(async (paths) => {
    try {
      opened.push(...(await readAbsoluteFiles(paths)));
      importing = true;
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
    }
  });
  // The dialog appears once the workspace and its fonts are ready (files can arrive at launch).
  $effect(() => {
    if (importDialog && opened.length) importDialog.addFiles(opened.splice(0));
  });
  let menu = $state<{ path: string; x: number; y: number } | null>(null);
  let fontKey = '';

  async function refreshIndex() {
    usedIn = await songbookIndex(workspace, files);
  }

  async function refresh() {
    files = await workspace.list();
    selected = selected.filter((f) => files.includes(f));
    refreshIndex();
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

  onSaveError((e) => (error = t('error.save', { msg: (e as Error).message })));
  // Any other failed operation (e.g. creating a file) is shown too, not only logged.
  window.addEventListener('unhandledrejection', (e) => (error = t('error.op', { msg: (e.reason as Error)?.message ?? String(e.reason) })));

  // Browser storage, and the backup reminder that goes with it.
  let browserWs: BrowserWorkspace | null = null;
  let backup = $state({ lastChange: 0, lastBackup: 0 });
  let storageProtected = $state(false);
  /** Folder used last time in this browser, waiting for the user's permission to reopen it. */
  let rememberedFolder = $state<Awaited<ReturnType<typeof BrowserFolderWorkspace.remembered>>>(null);

  async function useBrowserStorage() {
    if (!browserWs) {
      browserWs = await BrowserWorkspace.open();
      backup = browserWs.backup;
      browserWs.onchange = (b) => (backup = b);
      storageProtected = browserWs.storageProtected;
      browserWs.onprotected = () => (storageProtected = true);
    }
    workspace = browserWs;
  }

  // Start: the desktop app always works in a folder on disk; the website reopens the folder
  // used last time when the browser still allows it, and otherwise uses browser storage.
  (async () => {
    try {
      if (tiny()) {
        const r = await TinyWorkspace.start();
        workspace = r.ws;
        notice = r.notice ?? '';
        return;
      }
      const h = BrowserFolderWorkspace.supported() ? await BrowserFolderWorkspace.remembered() : null;
      const ws = h && (await BrowserFolderWorkspace.reopen(h, false));
      if (ws) workspace = ws;
      else {
        rememberedFolder = h;
        await useBrowserStorage();
      }
    } catch (e) {
      error = (e as Error).message;
      if (!tiny()) await useBrowserStorage();
    }
  })();

  async function reopenFolder() {
    if (!rememberedFolder) return;
    const ws = await BrowserFolderWorkspace.reopen(rememberedFolder, true);
    if (ws) {
      rememberedFolder = null;
      workspace = ws;
    }
  }

  async function switchToBrowser() {
    await BrowserFolderWorkspace.forget();
    rememberedFolder = null;
    await useBrowserStorage();
  }

  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(i18n.lang, { day: 'numeric', month: 'short', year: 'numeric' });
  const needsBackup = $derived(workspace.kind === 'browser' && backup.lastChange > backup.lastBackup);
  const where = (ws: Workspace) => (ws.kind === 'browser' ? t('where.browser') : t('where.folder', { name: ws.name }));

  async function openFolder() {
    try {
      const w = await pickFolder();
      if (w) {
        rememberedFolder = null;
        workspace = w;
      }
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
      if (workspace instanceof BrowserWorkspace) await workspace.markBackedUp();
      workspace = target;
      await tick();
      current = open;
      notice = t('ws.copied', { n, name: target.name });
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
    }
  }

  async function downloadZip() {
    try {
      await settleSaves();
      const name = workspace instanceof BrowserWorkspace ? `narwal-backup-${new Date().toISOString().slice(0, 10)}.zip` : `${workspace.name}.zip`;
      if ((await saveFile(name, await zipWorkspace(workspace), 'application/zip')) && workspace instanceof BrowserWorkspace) await workspace.markBackedUp();
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
    }
  }

  /** Add the files of a .zip (e.g. a backup made with "Download all") to the workspace. */
  async function openZip() {
    const [zip] = await pickLocalFiles(['zip']);
    if (!zip) return;
    let entries: [string, Uint8Array][];
    try {
      entries = filesFromZip(zip.bytes);
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
      return;
    }
    if (!entries.length) {
      error = t('ws.zipEmpty', { name: zip.name });
      return;
    }
    const replaced = entries.filter(([p]) => files.includes(p)).length;
    if (!confirm(t('ws.zipConfirm', { n: entries.length, name: zip.name, where: where(workspace) }) + (replaced ? '\n\n' + t('ws.zipReplace', { n: replaced }) : ''))) return;
    await withEditorsClosed(async () => {
      for (const [p, b] of entries) await workspace.writeBytes(p, b);
      notice = t('ws.zipDone', { n: entries.length, name: zip.name });
      return { from: '', to: null };
    });
  }

  async function downloadBookZip(path: string) {
    menu = null;
    try {
      await settleSaves();
      const { zip, missing } = await zipSongbook(workspace, path);
      const name = path.split('/').pop()!.replace(/\.songbook\.ya?ml$/i, '');
      if ((await saveFile(`${name}.zip`, zip, 'application/zip')) && missing.length) error = t('book.zipMissing', { files: missing.join(', ') });
    } catch (e) {
      error = t('error.op', { msg: (e as Error).message });
    }
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

  const unused = (f: string) => !usedIn[f]?.length;
  const songs = $derived(
    files
      .filter(isSong)
      .filter((f) => !filter || (titles[f] ?? f).toLowerCase().includes(filter.toLowerCase()))
      .filter((f) => !onlyUnused || unused(f))
      .sort((a, b) => (titles[a] ?? a).localeCompare(titles[b] ?? b)),
  );
  const books = $derived(files.filter(isSongbook));
  const pages = $derived(files.filter(isPage).filter((f) => !onlyUnused || unused(f)));
  const unusedCount = $derived(files.filter((f) => (isSong(f) || isPage(f)) && unused(f)).length);
  /** The songbook open in the editor, whose songs and pages are marked in the sidebar. */
  const openBook = $derived(current && isSongbook(current) ? current : null);
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

  /** Delete files after a confirmation that lists, songbook by songbook, what each will lose. */
  async function remove(paths: string[]) {
    menu = null;
    if (!paths.length) return;
    await settleSaves();
    const index = await songbookIndex(workspace, files);
    const byBook = new Map<string, string[]>();
    for (const p of paths) for (const b of index[p] ?? []) if (!paths.includes(b)) byBook.set(b, [...(byBook.get(b) ?? []), p]);
    const names = (list: string[], max: number) =>
      list.slice(0, max).map(label).join(', ') + (list.length > max ? ' ' + t('confirm.more', { n: list.length - max }) : '');
    let msg =
      paths.length === 1
        ? t('confirm.delete', { name: label(paths[0]) })
        : t('confirm.deleteMany', { n: paths.length }) + '\n' + paths.slice(0, 12).map((p) => '• ' + label(p)).join('\n') + (paths.length > 12 ? '\n' + t('confirm.more', { n: paths.length - 12 }) : '');
    if (byBook.size) {
      msg += '\n\n' + t(paths.length === 1 ? 'confirm.deleteUsed' : 'confirm.deleteManyUsed') + '\n';
      msg += [...byBook].map(([b, ps]) => '• ' + baseName(b) + (paths.length > 1 ? ': ' + names(ps, 6) : '')).join('\n');
    }
    if (!confirm(msg)) return;
    const open = current;
    await withEditorsClosed(async () => {
      await deleteFiles(workspace, files, paths);
      for (const p of paths) delete titles[p];
      selected = [];
      selecting = false;
      return { from: open && paths.includes(open) ? open : '', to: null };
    });
  }

  function toggleSelected(f: string) {
    selected = selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f];
  }

  function stopSelecting() {
    selecting = false;
    selected = [];
  }

  /** Tooltip of a song or page in the sidebar: its name and the songbooks including it. */
  function membership(f: string, text: string) {
    const books = usedIn[f] ?? [];
    return text + '\n' + (books.length ? t('side.inBooks', { books: books.map(baseName).join(', ') }) : t('side.inNoBook'));
  }
  // Web-sized copy of assets/narwal-logo.png (the master, also the app icon).
  const LOGO = import.meta.env.BASE_URL + 'narwal-logo-256.png';
</script>

{#snippet item(f: string, text: string)}
  {@const member = !isSongbook(f)}
  {@const books = usedIn[f] ?? []}
  {@const pick = selecting && member}
  <li
    class:active={current === f && !pick}
    class:menu-open={menu?.path === f}
    class:unused={member && !books.length}
    class:in-open={!!openBook && books.includes(openBook)}
    class:checked={pick && selected.includes(f)}
    oncontextmenu={(e) => openMenu(f, e)}
  >
    {#if pick}<input type="checkbox" checked={selected.includes(f)} onchange={() => toggleSelected(f)} aria-label={text} />{/if}
    <button class="open" onclick={() => (pick ? toggleSelected(f) : (current = f))} title={member ? membership(f, text) : text}>{text}</button>
    {#if member}<span class="books" title={membership(f, text)}>{books.length || '○'}</span>{/if}
    {#if !pick}<button class="more" title={t('menu.more')} aria-label={t('menu.more')} onclick={(e) => openMenu(f, e)}>⋯</button>{/if}
  </li>
{/snippet}

<svelte:window
  onclick={() => (menu = null)}
  onkeydown={(e) => {
    if (e.key !== 'Escape') return;
    if (menu) menu = null;
    else if (selecting && !importing) stopSelecting();
  }}
/>

<div class="app">
  <aside>
    <div class="brand"><img src={LOGO} alt="" />{__APP_NAME__}</div>
    <div class="ws">
      {#if ready}
        <div class="ws-name" title={t('ws.title')}>{workspace.kind === 'browser' ? '🌐' : '📁'} {workspace.name}</div>
        <p class="note" class:warn={workspace.kind === 'browser'}>
          {#if workspace instanceof BrowserWorkspace && !workspace.persistent}
            {t('ws.memoryOnly')}
          {:else if workspace.kind === 'browser'}
            {t('ws.browserNote')}
          {:else if workspace.location}
            {t('ws.folderPath', { path: workspace.location })}
          {:else}
            {t('ws.folderName', { name: workspace.name })}
          {/if}
        </p>
        {#if workspace instanceof BrowserWorkspace && storageProtected}
          <p class="note ok" title={t('ws.protectedHelp')}>✓ {t('ws.protected')}</p>
        {/if}
        {#if workspace.kind === 'browser'}
          <p class="note" class:warn={needsBackup}>
            {#if !backup.lastBackup}
              {t('ws.backupNever')}
            {:else if needsBackup}
              {t('ws.backupChanged', { date: fmtDate(backup.lastBackup) })}
            {:else}
              {t('ws.backupOk', { date: fmtDate(backup.lastBackup) })}
            {/if}
          </p>
        {/if}
        {#if rememberedFolder}
          <button class="wide" onclick={reopenFolder}>📁 {t('ws.reopen', { name: rememberedFolder.name })}</button>
        {/if}
        <div class="ws-actions">
          {#if canUseFolders}
            <button onclick={openFolder}>{t('ws.open')}</button>
          {/if}
          <button onclick={() => (importing = true)} disabled={!fonts}>{t('side.import')}</button>
        </div>
        {#if canUseFolders}
          <button class="wide" class:primary={workspace.kind === 'browser'} onclick={saveAllToFolder}>{t('ws.saveToFolder')}</button>
        {/if}
        <div class="ws-actions">
          <button onclick={downloadZip} class:primary={needsBackup && !canUseFolders}>{t('ws.zip')}</button>
          <button onclick={openZip}>{t('ws.openZip')}</button>
        </div>
        {#if workspace.kind === 'folder' && !tiny()}
          <button class="link" onclick={switchToBrowser}>🌐 {t('ws.useBrowser')}</button>
        {/if}
      {/if}
      {#if notice}<p class="note ok">{notice}</p>{/if}
    </div>

    <h3>{t('side.songbooks')} <button class="add" onclick={newBook} title={t('side.newSongbook')}>+</button></h3>
    <ul>
      {#each books as f (f)}{@render item(f, '📖 ' + baseName(f))}{/each}
    </ul>

    <div class="tools">
      <label title={t('side.onlyUnusedHelp')}><input type="checkbox" bind:checked={onlyUnused} /> {t('side.onlyUnused', { n: unusedCount })}</label>
      {#if !selecting}<button class="link" onclick={() => (selecting = true)} title={t('side.selectHelp')}>{t('side.select')}</button>{/if}
    </div>

    <h3>{t('side.pages')} <button class="add" onclick={newPage} title={t('side.newPage')}>+</button></h3>
    <ul>
      {#each pages as f (f)}{@render item(f, '📄 ' + baseName(f))}{/each}
    </ul>

    <h3>{t('side.songs')} <button class="add" onclick={newSong} title={t('side.newSong')}>+</button></h3>
    <input class="filter" placeholder={t('side.search')} bind:value={filter} />
    <ul class="songs">
      {#each songs as f (f)}{@render item(f, titles[f] ?? baseName(f))}{/each}
    </ul>

    {#if selecting}
      <div class="selection">
        <span>{t('side.selected', { n: selected.length })}</span>
        <button class="link" onclick={() => (selected = [...pages, ...songs])}>{t('side.selectAll')}</button>
        <button class="danger" disabled={!selected.length} onclick={() => remove(selected)}>{t('side.deleteSelected')}</button>
        <button onclick={stopSelecting}>{t('side.cancel')}</button>
      </div>
    {/if}

    <label class="lang">
      {t('side.language')}
      <select value={i18n.lang} onchange={(e) => setLang(e.currentTarget.value as Lang)}>
        {#each LANGS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
    </label>
  </aside>

  <main>
    {#if error}<div class="error" role="alert">{error} <button aria-label="✕" onclick={() => (error = '')}>✕</button></div>{/if}
    {#if fonts && current && (isSong(current) || isPage(current))}
      {@const books = usedIn[current] ?? []}
      <div class="used-in" class:unused={!books.length}>
        {#if books.length}
          {t('side.inBooksLabel')}
          {#each books as b (b)}<button onclick={() => (current = b)}>📖 {baseName(b)}</button>{/each}
        {:else}
          ○ {t('side.inNoBookHint')}
        {/if}
      </div>
    {/if}
    {#if !fonts}
      <div class="empty">{t('app.loading')}</div>
    {:else if current && isSong(current)}
      {#key current}
        <SongView {workspace} path={current} {fonts} onsaved={refresh} location={t('file.where', { path: current, where: where(workspace) })} />
      {/key}
    {:else if current && isSongbook(current)}
      {#key current}
        <BookView {workspace} path={current} {fonts} {files} onopen={(p) => (current = p)} onfileschanged={refresh} onsaved={refreshIndex} />
      {/key}
    {:else if current && isPage(current)}
      {#key current}
        <PageView {workspace} path={current} {fonts} {files} onfileschanged={refresh} />
      {/key}
    {:else}
      <div class="empty">
        <img class="logo" src={LOGO} alt="" />
        <h1>{__APP_NAME__}</h1>
        <p>{t('app.tagline')}</p>
        <p>{t('app.pick')}</p>
        <p class="create">
          <button onclick={newBook}>+ {t('side.newSongbook')}</button>
          <button onclick={newPage}>+ {t('side.newPage')}</button>
          <button onclick={newSong}>+ {t('side.newSong')}</button>
        </p>
      </div>
    {/if}
  </main>
</div>

{#if menu}
  {@const m = menu}
  <div class="menu" role="menu" style="left: {m.x}px; top: {m.y}px">
    <button role="menuitem" onclick={() => rename(m.path)}>{t('menu.rename')}</button>
    <button role="menuitem" onclick={() => saveCopy(m.path)}>{t('menu.saveAs')}</button>
    {#if isSongbook(m.path)}
      <button role="menuitem" onclick={() => downloadBookZip(m.path)}>{t('book.zip')}</button>
    {/if}
    <button role="menuitem" class="danger" onclick={() => remove([m.path])}>{t('menu.delete')}</button>
  </div>
{/if}

{#if importing && fonts}
  <ImportDialog
    bind:this={importDialog}
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
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -4px 0 12px;
    font-size: 16px;
    font-weight: 700;
  }
  .brand img {
    width: 34px;
    height: 34px;
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
  .ws button.link {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }
  .ws button.link:hover {
    color: var(--fg);
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
  .ws button.primary {
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
    display: flex;
    flex-direction: column;
  }
  /* The editor takes the height left by the error bar and the songbooks line. */
  main > :global(.song-view),
  main > :global(.book-view),
  main > :global(.page-view) {
    flex: 1;
    height: auto;
  }
  .used-in {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 5px 16px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }
  .used-in button {
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    border-radius: 10px;
    padding: 1px 8px;
    font: inherit;
    cursor: pointer;
  }
  .used-in button:hover {
    border-color: var(--accent);
  }
  .tools {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    font-size: 12px;
    color: var(--muted);
  }
  .tools button.link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  /* Songbooks including each song or page; ○ when none. */
  .books {
    flex: none;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    font-size: 11px;
    text-align: center;
    color: var(--muted);
    background: var(--chip-hover);
  }
  li.unused .open {
    color: var(--muted);
    font-style: italic;
  }
  li.unused .books {
    background: none;
  }
  /* Members of the songbook open in the editor. */
  li.in-open {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  li.in-open .books {
    background: var(--accent);
    color: var(--on-accent);
  }
  li.active .books {
    color: var(--on-accent);
    background: rgba(255, 255, 255, 0.25);
  }
  li input[type='checkbox'] {
    margin: 0 0 0 6px;
  }
  li.checked {
    background: var(--line-focus);
  }
  .selection {
    position: sticky;
    bottom: -12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 8px -12px -12px;
    padding: 8px 12px;
    background: var(--sidebar);
    border-top: 1px solid var(--line);
    font-size: 12px;
  }
  .selection span {
    flex: 1 0 100%;
    font-weight: 600;
  }
  .selection button {
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    border-radius: 5px;
    padding: 2px 8px;
    font: inherit;
    cursor: pointer;
  }
  .selection button.link {
    border: none;
    background: none;
    color: var(--accent);
    padding: 0;
    margin-right: auto;
  }
  .selection button.danger {
    background: #c5221f;
    border-color: #c5221f;
    color: #fff;
  }
  .empty {
    padding: 48px;
    color: var(--muted);
  }
  .empty .logo {
    width: 160px;
    height: 160px;
  }
  .empty h1 {
    color: var(--fg);
  }
  .create {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
  }
  .create button {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
  }
  .create button:hover {
    text-decoration: underline;
  }
  .error {
    display: flex;
    gap: 8px;
    align-items: start;
    justify-content: space-between;
    background: #fde7e9;
    color: #b3261e;
    padding: 8px 16px;
  }
  .error button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
  }
</style>
