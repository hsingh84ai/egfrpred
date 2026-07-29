import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Builds the app without SvelteKit, for scripts/build_single_file.mjs.
 *
 * The point is an output with nothing to fetch: one script, one stylesheet, no
 * code splitting and so no dynamic imports for Vite's preload helper to resolve
 * against import.meta.url -- which is what makes the result inlinable.
 */
export default defineConfig({
  root: here,
  // The page is opened from disk, so every URL in it must be relative.
  base: './',
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('../../src/lib', import.meta.url)),
      '$app/paths': fileURLToPath(new URL('./app-paths.ts', import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ['@rdkit/rdkit'] },
  build: {
    outDir: fileURLToPath(new URL('../../.svelte-kit/standalone', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    cssCodeSplit: false,
    modulePreload: false,
    // Anything left as a separate asset would be a file the page has to go and
    // find; inline it instead. The threshold is above the largest asset here.
    assetsInlineLimit: 50 * 1024 * 1024,
    // Nothing here imports dynamically, so this entry is the only chunk.
    rollupOptions: {
      output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' },
    },
  },
  logLevel: 'warn',
});
