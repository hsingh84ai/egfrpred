import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // The RDKit wasm binary is served from /static as-is; excluding the package
  // from dependency optimisation keeps Vite from trying to bundle its loader.
  optimizeDeps: { exclude: ['@rdkit/rdkit'] },
});
