<script lang="ts">
  // Import songs (.odt, .txt, .cho), images and fonts into the workspace.
  // Songs written with chords above the lyrics are converted to ChordPro.
  import type { FontRegistry } from '../core/fonts';
  import { isFontFile } from '../core/fonts';
  import { IMPORTABLE, importFile, importText, slugify } from '../core/import';
  import { t } from './i18n.svelte';
  import { isImage, readExternalFiles, tiny, type Workspace } from './workspace';

  let { workspace, fonts, files, onclose }: { workspace: Workspace; fonts: FontRegistry; files: string[]; onclose: (opened?: string) => void } = $props();

  let messages: string[] = $state([]);
  let pasted = $state('');
  let pastedTitle = $state('');
  let dragging = $state(false);
  let busy = $state(false);
  let lastSong: string | undefined;
  let taken: Set<string> | undefined;

  function unique(base: string, ext: string) {
    taken ??= new Set(files);
    let name = `${base}${ext}`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}${ext}`;
    taken.add(name);
    return name;
  }

  async function addFile(name: string, bytes: Uint8Array): Promise<string> {
    const base = name.split('/').pop()!;
    if (isImage(base)) {
      const p = unique(`images/${base.replace(/\.[^.]+$/, '')}`, base.slice(base.lastIndexOf('.')).toLowerCase());
      await workspace.writeBytes(p, bytes);
      return p;
    }
    if (isFontFile(base)) {
      const p = unique(`fonts/${base.replace(/\.[^.]+$/, '')}`, base.slice(base.lastIndexOf('.')).toLowerCase());
      await workspace.writeBytes(p, bytes);
      return p;
    }
    if (!IMPORTABLE.test(base)) throw new Error('unsupported file type');
    const song = importFile(base, bytes, fonts);
    const p = unique(`songs/${slugify(song.title)}`, '.cho');
    await workspace.writeText(p, song.chordpro);
    lastSong = p;
    return p;
  }

  async function run(items: { name: string; bytes: Uint8Array }[]) {
    busy = true;
    let n = 0;
    for (const it of items) {
      try {
        const p = await addFile(it.name, it.bytes);
        messages.push(`${it.name} → ${p}`);
        n++;
      } catch (e) {
        messages.push(t('import.error', { file: it.name, msg: (e as Error).message }));
      }
    }
    messages.push(t('import.done', { n }));
    busy = false;
  }

  async function pick() {
    if (tiny()) {
      await run(await readExternalFiles());
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.odt,.txt,.cho,.chordpro,.chopro,.crd,.png,.jpg,.jpeg,.ttf,.otf';
    input.onchange = async () => {
      const list = [...(input.files ?? [])];
      await run(await Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.click();
  }

  async function drop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const list = [...(e.dataTransfer?.files ?? [])];
    await run(await Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  }

  async function importPasted() {
    const song = importText(pasted, pastedTitle || t('prompt.songTitleDefault'));
    const p = unique(`songs/${slugify(song.title)}`, '.cho');
    await workspace.writeText(p, song.chordpro);
    lastSong = p;
    messages.push(`→ ${p}`);
    pasted = '';
    pastedTitle = '';
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose(lastSong)}>
  <div
    class="dialog"
    class:dragging
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
  >
    <h2>{t('import.title')}</h2>
    <button class="primary" onclick={pick} disabled={busy}>{t('import.files')}</button>
    <p class="help">{t('import.filesHelp')}</p>
    <p class="where">{t('import.where', { where: workspace.kind === 'browser' ? t('where.browser') : t('where.folder', { name: workspace.location ?? workspace.name }) })}</p>

    <h3>{t('import.paste')}</h3>
    <input placeholder={t('import.pasteName')} bind:value={pastedTitle} />
    <textarea bind:value={pasted} rows="10" spellcheck="false" placeholder={'      C          G\nThere was a king who ruled the land'}></textarea>
    <button onclick={importPasted} disabled={!pasted.trim()}>{t('import.convert')}</button>

    {#if messages.length}
      <ul class="log">{#each messages as m, i (i)}<li>{m}</li>{/each}</ul>
    {/if}
    <div class="footer"><button onclick={() => onclose(lastSong)}>{t('import.close')}</button></div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .dialog {
    background: var(--bg);
    color: var(--fg);
    border-radius: 10px;
    padding: 20px 24px;
    width: min(640px, 92vw);
    max-height: 90vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    border: 2px solid transparent;
  }
  .dialog.dragging {
    border-color: var(--accent);
  }
  h2 {
    margin: 0 0 4px;
    font-size: 18px;
  }
  h3 {
    margin: 12px 0 0;
    font-size: 14px;
  }
  .help {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }
  input,
  textarea {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  textarea {
    font: 13px/1.35 ui-monospace, Menlo, monospace;
  }
  button {
    align-self: flex-start;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    border-radius: 5px;
    padding: 4px 12px;
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .where {
    font-size: 12px;
    margin: 0;
    padding: 6px 8px;
    border-radius: 5px;
    background: var(--chip-hover);
  }
  .log {
    font-size: 12px;
    color: var(--muted);
    max-height: 160px;
    overflow: auto;
    margin: 4px 0;
    padding-left: 18px;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
  }
</style>
