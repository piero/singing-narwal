import { readFileSync } from 'node:fs'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// The product name lives only in tinyjs.json ("title"), so a rename is a one-line change.
const appName: string = JSON.parse(readFileSync(new URL('./tinyjs.json', import.meta.url), 'utf8')).title

export default defineConfig({
  plugins: [
    svelte(),
    { name: 'app-name', transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', appName) },
  ],
  define: { __APP_NAME__: JSON.stringify(appName) },
  // Relative asset paths, so the build also works when loaded from disk by TinyJS.
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
})
