// Pending autosaves. Editors save a moment after the last change; when an editor
// closes it writes immediately and registers the write here, so that renaming or
// deleting the file can wait for it instead of racing with it.

const pending = new Set<Promise<unknown>>();

export function trackSave(p: Promise<unknown>) {
  pending.add(p);
  p.finally(() => pending.delete(p));
}

export async function settleSaves() {
  await Promise.allSettled([...pending]);
}

/**
 * Debounced saver: `schedule` (re)starts the timer, `flush` saves right away if
 * a save is pending (call it when the editor closes).
 */
export function debouncedSaver(delay: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let job: (() => Promise<void>) | null = null;
  return {
    schedule(fn: () => Promise<void>) {
      clearTimeout(timer);
      job = fn;
      timer = setTimeout(() => {
        const j = job;
        job = null;
        if (j) trackSave(j());
      }, delay);
    },
    flush() {
      clearTimeout(timer);
      const j = job;
      job = null;
      if (j) trackSave(j());
    },
  };
}
