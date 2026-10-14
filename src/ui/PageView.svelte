<script lang="ts">
  // Editor for pages (.page.yaml): a list of elements with their
  // settings, a YAML source view and a live preview.
  import { onDestroy } from 'svelte';
  import { debouncedSaver } from './saves';
  import { fontFamilies, fontFamily, fontVariant, type FontRegistry } from '../core/fonts';
  import { imageSize } from '../core/images';
  import { PAGE_SIZES, type PageSizeName } from '../core/impose';
  import { DEFAULT_STYLE } from '../core/layout';
  import {
    elementKind,
    layoutPage,
    parsePage,
    serializePage,
    pageImages,
    type ElementKind,
    type PageElement,
    type PageDoc,
  } from '../core/pages';
  import { ImageUrls } from './assets.svelte';
  import { t, type Key } from './i18n.svelte';
  import Preview from './Preview.svelte';
  import { isImage, type Workspace } from './workspace';

  let { workspace, path, fonts, files }: { workspace: Workspace; path: string; fonts: FontRegistry; files: string[] } = $props();

  let tpl = $state<PageDoc | null>(null);
  let mode: 'elements' | 'source' = $state('elements');
  let page: PageSizeName = $state('A5');
  let previewTitle = $state('Canzoniere');
  let savedText = '';
  let sizes: Record<string, { width: number; height: number }> = $state({});
  const images = new ImageUrls((p) => workspace.readBytes(p));

  $effect(() => {
    workspace.readText(path).then((text) => {
      tpl = parsePage(text);
      savedText = serializePage(tpl);
    });
  });

  // Autosave.
  const saver = debouncedSaver(500);
  onDestroy(saver.flush);
  $effect(() => {
    if (!tpl) return;
    const text = serializePage(tpl);
    if (text === savedText) return;
    const target = path;
    saver.schedule(async () => {
      await workspace.writeText(target, text);
      savedText = text;
    });
  });

  // Image sizes, needed by the layout.
  $effect(() => {
    if (!tpl) return;
    for (const src of pageImages(tpl)) {
      if (sizes[src]) continue;
      workspace
        .readBytes(src)
        .then((b) => (sizes[src] = imageSize(b)))
        .catch(() => {});
    }
  });

  const laid = $derived.by(() => {
    if (!tpl) return null;
    return layoutPage($state.snapshot(tpl) as PageDoc, {
      fonts,
      ...PAGE_SIZES[page],
      defaultMargin: DEFAULT_STYLE.margin.left,
      defaultFont: DEFAULT_STYLE.lyrics.font,
      vars: { title: previewTitle },
      imageSizes: sizes,
    });
  });
  const sheets = $derived(laid ? [{ width: laid.width, height: laid.height, placements: [{ page: laid, x: 0, y: 0 }], foldLine: false }] : []);

  const KINDS: { kind: ElementKind; label: Key; make: () => PageElement }[] = [
    { kind: 'text', label: 'page.text', make: () => ({ text: 'Testo', size: 14 }) },
    { kind: 'image', label: 'page.image', make: () => ({ image: '', height: 'fill' }) },
    { kind: 'box', label: 'page.box', make: () => ({ box: '', height: 80, radius: 10 }) },
    { kind: 'lines', label: 'page.lines', make: () => ({ lines: 10, spacing: 22 }) },
    { kind: 'space', label: 'page.space', make: () => ({ space: 20 }) },
    { kind: 'rule', label: 'page.rule', make: () => ({ rule: true }) },
  ];
  const kindLabel = (k: ElementKind) => t(KINDS.find((x) => x.kind === k)!.label);

  function move(i: number, d: number) {
    const els = tpl!.elements;
    const j = i + d;
    if (j < 0 || j >= els.length) return;
    [els[i], els[j]] = [els[j], els[i]];
  }

  // Font picker: family + bold/italic, stored as a font id.
  const families = $derived(fontFamilies(fonts));
  type Styled = { font?: string };
  const isBold = (e: Styled) => /Bold/.test(e.font ?? '');
  const isItalic = (e: Styled) => /Italic|Oblique/.test(e.font ?? '');
  function setFont(e: Styled, family: string, bold: boolean, italic: boolean) {
    e.font = fontVariant(fonts, family, bold, italic);
  }

  // Heights: a number or "fill".
  type Sized = { height?: number | 'fill' };
  const fills = (e: Sized) => e.height === undefined || e.height === 'fill';

  let source = $state('');
  function showSource() {
    source = tpl ? serializePage(tpl) : '';
    mode = 'source';
  }
  function editSource(text: string) {
    source = text;
    try {
      tpl = parsePage(text);
    } catch {
      /* keep the last valid page while typing */
    }
  }
</script>

{#snippet fontPicker(e: Styled)}
  <label>
    {t('page.font')}
    <select value={fontFamily(e.font ?? DEFAULT_STYLE.lyrics.font)} onchange={(ev) => setFont(e, ev.currentTarget.value, isBold(e), isItalic(e))}>
      {#each families as f (f)}<option value={f}>{f}</option>{/each}
    </select>
  </label>
  <button class="toggle b" class:on={isBold(e)} onclick={() => setFont(e, fontFamily(e.font ?? DEFAULT_STYLE.lyrics.font), !isBold(e), isItalic(e))}>B</button>
  <button class="toggle i" class:on={isItalic(e)} onclick={() => setFont(e, fontFamily(e.font ?? DEFAULT_STYLE.lyrics.font), isBold(e), !isItalic(e))}>I</button>
{/snippet}

{#snippet alignPicker(e: { align?: 'left' | 'center' | 'right' })}
  <label>
    {t('page.align')}
    <select bind:value={e.align}>
      <option value={undefined}>{t('page.left')}</option>
      <option value="center">{t('page.center')}</option>
      <option value="right">{t('page.right')}</option>
    </select>
  </label>
{/snippet}

{#snippet heightPicker(e: Sized)}
  <label>
    {t('page.height')}
    <input type="number" min="0" disabled={fills(e)} value={fills(e) ? '' : e.height} oninput={(ev) => (e.height = Number(ev.currentTarget.value) || 0)} />
  </label>
  <label><input type="checkbox" checked={fills(e)} onchange={(ev) => (e.height = ev.currentTarget.checked ? 'fill' : 80)} /> {t('page.fill')}</label>
{/snippet}

{#if tpl}
  <div class="page-view">
    <section class="edit-pane">
      <div class="tabs">
        <button class:active={mode === 'elements'} onclick={() => (mode = 'elements')}>{t('page.elements')}</button>
        <button class:active={mode === 'source'} onclick={showSource}>{t('page.source')}</button>
      </div>
      {#if mode === 'elements'}
        <ol class="elements">
          {#each tpl.elements as e, i (i)}
            {@const kind = elementKind(e)}
            <li>
              <header>
                <strong>{kindLabel(kind)}</strong>
                <span class="actions">
                  <button title={t('book.moveUp')} onclick={() => move(i, -1)}>↑</button>
                  <button title={t('book.moveDown')} onclick={() => move(i, 1)}>↓</button>
                  <button title={t('book.remove')} onclick={() => tpl!.elements.splice(i, 1)}>✕</button>
                </span>
              </header>
              <div class="fields">
                {#if 'text' in e}
                  <textarea rows={Math.max(2, e.text.split('\n').length)} bind:value={e.text}></textarea>
                  {@render fontPicker(e)}
                  <label>{t('page.size')} <input type="number" min="4" step="0.5" bind:value={e.size} /></label>
                  {@render alignPicker(e)}
                  <label>{t('page.lineHeight')} <input type="number" min="0.8" step="0.05" bind:value={e.line_height} placeholder="1.25" /></label>
                  <label>{t('page.indent')} <input type="number" min="0" bind:value={e.indent} placeholder="0" /></label>
                {:else if 'image' in e}
                  <select bind:value={e.image}>
                    <option value="">{t('page.chooseImage')}</option>
                    {#each files.filter(isImage) as f (f)}<option value={f}>{f}</option>{/each}
                  </select>
                  {@render heightPicker(e)}
                  <label>{t('page.width')} <input type="number" min="5" max="100" value={Math.round((e.width ?? 1) * 100)} oninput={(ev) => (e.width = Number(ev.currentTarget.value) / 100)} /></label>
                  {@render alignPicker(e)}
                {:else if 'box' in e}
                  <label class="wide">{t('page.label')} <input bind:value={e.box} /></label>
                  {@render heightPicker(e)}
                  <label>{t('page.radius')} <input type="number" min="0" bind:value={e.radius} /></label>
                  {@render fontPicker(e)}
                  <label>{t('page.size')} <input type="number" min="4" step="0.5" bind:value={e.size} placeholder="13" /></label>
                  {@render alignPicker(e)}
                {:else if 'lines' in e}
                  <label>{t('page.count')} <input type="number" min="1" disabled={e.lines === 'fill'} value={e.lines === 'fill' ? '' : e.lines} oninput={(ev) => (e.lines = Number(ev.currentTarget.value) || 1)} /></label>
                  <label><input type="checkbox" checked={e.lines === 'fill'} onchange={(ev) => (e.lines = ev.currentTarget.checked ? 'fill' : 10)} /> {t('page.fill')}</label>
                  <label>{t('page.spacing')} <input type="number" min="8" bind:value={e.spacing} placeholder="20" /></label>
                {:else if 'space' in e}
                  <label>{t('page.height')} <input type="number" min="0" disabled={e.space === 'fill'} value={e.space === 'fill' ? '' : e.space} oninput={(ev) => (e.space = Number(ev.currentTarget.value) || 0)} /></label>
                  <label><input type="checkbox" checked={e.space === 'fill'} onchange={(ev) => (e.space = ev.currentTarget.checked ? 'fill' : 20)} /> {t('page.fill')}</label>
                {/if}
                {#if !('space' in e)}
                  <label>{t('page.marginTop')} <input type="number" min="0" bind:value={e.margin} placeholder="0" /></label>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
        <div class="add">
          <span>{t('page.add')}</span>
          {#each KINDS as k (k.kind)}
            <button onclick={() => tpl!.elements.push(k.make())}>{t(k.label)}</button>
          {/each}
        </div>
        <p class="help">{t('page.placeholders')}</p>
      {:else}
        <textarea class="source" value={source} oninput={(e) => editSource(e.currentTarget.value)} spellcheck="false"></textarea>
      {/if}
    </section>
    <section class="preview-pane">
      <div class="toolbar">
        <label>{t('opt.page')} <select bind:value={page}>{#each Object.keys(PAGE_SIZES) as p (p)}<option value={p}>{p}</option>{/each}</select></label>
        <label>{t('page.previewTitle')} <input bind:value={previewTitle} /></label>
      </div>
      <div class="preview-scroll">
        <Preview {sheets} imageUrl={(src) => images.get(src)} />
      </div>
    </section>
  </div>
{/if}

<style>
  .page-view {
    display: grid;
    grid-template-columns: minmax(420px, 1fr) minmax(380px, 1fr);
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
    padding: 0 16px 16px;
  }
  .tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 12px;
    padding-top: 8px;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 4px;
    color: var(--muted);
    cursor: pointer;
  }
  .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .elements {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .elements li {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .actions button {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--muted);
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    font-size: 13px;
  }
  .fields textarea {
    width: 100%;
    font: 14px/1.4 inherit;
  }
  .wide {
    flex: 1 1 100%;
  }
  .wide input {
    flex: 1;
  }
  input,
  select,
  textarea {
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
  .toggle {
    width: 26px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    border-radius: 4px;
    cursor: pointer;
  }
  .toggle.b {
    font-weight: bold;
  }
  .toggle.i {
    font-style: italic;
  }
  .toggle.on {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-top: 12px;
    font-size: 13px;
  }
  .help {
    font-size: 12px;
    color: var(--muted);
  }
  .source {
    width: 100%;
    min-height: 500px;
    font: 13px/1.5 ui-monospace, Menlo, monospace;
    box-sizing: border-box;
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
  .preview-scroll {
    overflow: auto;
    flex: 1;
    min-height: 0;
    background: var(--canvas);
  }
</style>
