/**
 * Stands in for `$app/paths`, which only exists inside SvelteKit.
 *
 * The single consumer is src/lib/rdkit.ts, which uses `base` to locate
 * RDKit_minimal.js and its .wasm. In the standalone build both are already
 * embedded in the page and `window.initRDKitModule` is registered before the app
 * runs, so that code path is never reached and the value is never used.
 */

export const base = '';
export const assets = '';
