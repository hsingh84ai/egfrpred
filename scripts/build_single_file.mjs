/**
 * Folds the whole app into one self-contained .html file.
 *
 * The normal build is a directory: index.html plus hashed JS/CSS chunks plus
 * RDKit's loader and its 7 MB .wasm. That needs a web server, because ES module
 * imports and wasm fetches both fail under file://. This produces a single file
 * that can be opened by double-clicking it, mailed around, or attached to a
 * release -- with the same no-network guarantee the hosted site makes.
 *
 * It does not post-process the SvelteKit build. That output is a router that
 * resolves a route from location.pathname and loads its chunks through Vite's
 * preload helper, which resolves them against import.meta.url; neither survives
 * being flattened into one file opened from disk. Instead the app is rebuilt
 * from scripts/standalone/, which mounts the same page component with plain
 * Vite into one script and one stylesheet -- see that directory's vite.config.
 *
 * Then three things are inlined: the stylesheet as a <style>, the app as a
 * <script>, and RDKit as its loader plus the .wasm base64-encoded and handed to
 * Emscripten through `wasmBinary`, which stops it fetching the binary at all.
 *
 * Usage:  npm run build:single
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGED = join(ROOT, '.svelte-kit/standalone');
const RDKIT = join(ROOT, 'node_modules/@rdkit/rdkit/dist');
const OUT = join(ROOT, 'build/egfrpred-standalone.html');

/**
 * A literal </script> inside inlined JS would close the element early. Escaping
 * the slash is inert inside a string literal, which is the only place Emscripten
 * and the app bundle contain one.
 */
const escapeScript = (js) => js.replace(/<\/script/gi, '<\\/script');

/**
 * Replace with a function, never a string: minified JS contains "$&" and other
 * replacement patterns that String.replace would expand.
 */
const insert = (html, pattern, text, what) => {
  if (!pattern.test(html)) throw new Error(`no ${what} in the standalone build's index.html`);
  return html.replace(pattern, () => text);
};

/**
 * RDKit's loader, then a shim that intercepts initRDKitModule to supply the
 * decoded module bytes. Emscripten skips its own fetch when `wasmBinary` is set,
 * so nothing is requested over the network or off the disk. The loader also
 * registers window.initRDKitModule, which is what makes src/lib/rdkit.ts take
 * its already-loaded path instead of appending a <script src>.
 */
function inlineRDKit() {
  const loader = readFileSync(join(RDKIT, 'RDKit_minimal.js'), 'utf8');
  const wasm = readFileSync(join(RDKIT, 'RDKit_minimal.wasm')).toString('base64');
  const shim = `
    (() => {
      const encoded = atob(${JSON.stringify(wasm)});
      const bytes = new Uint8Array(encoded.length);
      for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
      const init = window.initRDKitModule;
      window.initRDKitModule = (options) => init({ ...options, wasmBinary: bytes });
    })();
  `;
  return `<script>${escapeScript(loader)}</script>\n<script>${escapeScript(shim)}</script>`;
}

/** Nothing may be left that the browser would have to go and get. */
function assertSelfContained(html) {
  const external = [
    [/<script[^>]+\ssrc=/i, 'a <script src=...>'],
    [/<link[^>]+rel="stylesheet"/i, 'a stylesheet <link>'],
    [/<link[^>]+rel="modulepreload"/i, 'a modulepreload <link>'],
    [/<link[^>]+href="(?!data:)/i, 'a <link> to a file'],
    [/\bimport\s*\(/, 'a dynamic import()'],
  ];
  for (const [pattern, what] of external) {
    if (pattern.test(html)) throw new Error(`output still references ${what}`);
  }
}

await build({ configFile: join(ROOT, 'scripts/standalone/vite.config.ts') });

const read = (file) => readFileSync(join(STAGED, file), 'utf8');
let html = read('index.html');

html = insert(html, /<script type="module"[^>]*src="[^"]*"><\/script>/,
              `<script type="module">${escapeScript(read('app.js'))}</script>`, 'app <script>');
html = insert(html, /<link rel="stylesheet"[^>]*href="[^"]*"[^>]*>/,
              `<style>${read('app.css')}</style>`, 'stylesheet <link>');
// Before the app: the module script is deferred, so RDKit has registered itself
// by the time anything calls loadRDKit().
html = insert(html, /<div id="app"/, `${inlineRDKit()}\n<div id="app"`, 'app container');

assertSelfContained(html);
mkdirSync(join(ROOT, 'build'), { recursive: true });
writeFileSync(OUT, html);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nwrote build/egfrpred-standalone.html  ${mb(statSync(OUT).size)}`);
console.log(`  app ${mb(Buffer.byteLength(read('app.js')) + Buffer.byteLength(read('app.css')))}` +
            `, RDKit wasm ${mb(statSync(join(RDKIT, 'RDKit_minimal.wasm')).size)} (+33% base64)`);
