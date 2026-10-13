import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [svelte()],
  // Relative asset paths, so the build also works when loaded from disk by TinyJS.
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
})
