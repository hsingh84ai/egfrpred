/**
 * Stages RDKit's wasm bundle into static/ so the site can serve it.
 *
 * The 7 MB binary is not committed; it comes from node_modules, which keeps the
 * repository small and the runtime version pinned by package-lock.json.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const from = join(app, 'node_modules/@rdkit/rdkit/dist');
const to = join(app, 'static');

mkdirSync(to, { recursive: true });
for (const file of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) {
  copyFileSync(join(from, file), join(to, file));
  console.log(`staged ${file}`);
}
