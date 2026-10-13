<script lang="ts">
  // Live preview: draws laid-out pages (or imposed sheets) as SVG, from the same
  // display list used to write the PDF.
  import type { LaidPage } from '../core/layout';
  import type { Sheet } from '../core/impose';

  let {
    sheets,
    imageUrl = () => '',
    onlineclick,
  }: { sheets: Sheet[]; imageUrl?: (src: string) => string; onlineclick?: (line: number) => void } = $props();

  const drawable = (p: LaidPage | null) => p?.items ?? [];
</script>

<div class="preview">
  {#each sheets as sheet, si (si)}
    <svg class="sheet" viewBox="0 0 {sheet.width} {sheet.height}" style="aspect-ratio: {sheet.width} / {sheet.height}">
      <rect width={sheet.width} height={sheet.height} fill="white" />
      {#each sheet.placements as pl, pi (pi)}
        <g transform="translate({pl.x} {pl.y})">
          {#each drawable(pl.page) as it, k (k)}
            {#if it.type === 'text'}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <text
                x={it.x}
                y={it.y}
                font-family={it.font}
                font-size={it.size}
                class={it.role}
                class:link={it.line !== undefined && onlineclick}
                onclick={() => it.line !== undefined && onlineclick?.(it.line)}
                xml:space="preserve">{it.text}</text>
            {:else if it.type === 'rule'}
              <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke="black" stroke-width={it.width} />
            {:else if it.type === 'rect'}
              <rect x={it.x} y={it.y} width={it.width} height={it.height} rx={it.radius} fill="none" stroke="black" stroke-width={it.lineWidth} />
            {:else if it.type === 'image'}
              <image href={imageUrl(it.src)} x={it.x} y={it.y} width={it.width} height={it.height} />
            {/if}
          {/each}
        </g>
      {/each}
      {#if sheet.foldLine && sheet.placements.length === 2}
        <line x1={sheet.width / 2} y1="0" x2={sheet.width / 2} y2={sheet.height} stroke="#9ab" stroke-width="0.4" />
      {/if}
    </svg>
  {/each}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
    align-items: center;
  }
  .sheet {
    width: 100%;
    max-width: 900px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    background: white;
  }
  text {
    fill: #111;
    white-space: pre;
  }
  text.link {
    cursor: text;
  }
  text.link:hover {
    fill: #1a5fd0;
  }
</style>
