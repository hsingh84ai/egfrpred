/**
 * Checks that a drawn structure scores the same as the equivalent SMILES.
 *
 * The sketcher hands back a molfile, which is converted to SMILES and fed to the
 * ordinary pipeline. That conversion is the only new step between drawing and a
 * score, and it is the one that could silently change a molecule -- a lost
 * aromatic flag or charge would move fingerprint bits and therefore the
 * prediction.
 *
 * So: take every molecule in the corpus, round-trip it through the editor's own
 * molecule model and molfile writer, and compare the score against scoring the
 * SMILES directly. The editor is not driven here; `Molecule.toMolfile()` is what
 * it calls when the user presses add.
 *
 * Usage:  npm run test:sketcher
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import initRDKit from '@rdkit/rdkit/dist/RDKit_minimal.js';
import OCL from 'openchemlib';

const APP = fileURLToPath(new URL('..', import.meta.url));
const verbose = process.argv.includes('--verbose');

async function loadAppModules(scratch) {
  const entry = join(scratch, 'entry.mjs');
  const spec = (rel) => JSON.stringify(join(APP, rel).replace(/\\/g, '/'));
  writeFileSync(entry, `
    export { computeBits, compileQueries } from ${spec('src/lib/fingerprint/pubchem.ts')};
    export { MODEL_BITS, score, label } from ${spec('src/lib/model/forest.ts')};
    export { molfileToSmiles } from ${spec('src/lib/sketcher.ts')};
  `);
  const outfile = join(scratch, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm',
                platform: 'node', external: ['@rdkit/rdkit'], logLevel: 'warning' });
  return import(pathToFileURL(outfile).href);
}

/** Score a SMILES exactly as the app does. */
function scoreOf(RDKit, app, queries, smiles) {
  const mol = RDKit.get_mol(smiles);
  if (!mol) return null;
  try {
    return mol.is_valid() ? app.score(app.computeBits(mol, app.MODEL_BITS, queries)) : null;
  } finally {
    mol.delete();
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'egfrpred-sketch-'));
try {
  const RDKit = await initRDKit();
  const app = await loadAppModules(scratch);
  const fixture = JSON.parse(
    gunzipSync(readFileSync(join(APP, 'tests/fixtures/padel-bits.json.gz'))).toString('utf8'));

  const queries = app.compileQueries(RDKit, app.MODEL_BITS);

  let compared = 0;
  let unreadable = 0;
  const disagreements = [];

  for (const { id, smiles } of fixture.molecules) {
    const direct = scoreOf(RDKit, app, queries, smiles);
    if (direct === null) continue;

    // The editor's round trip: SMILES -> its molecule model -> molfile -> us.
    let drawnSmiles;
    try {
      drawnSmiles = app.molfileToSmiles(RDKit, OCL.Molecule.fromSmiles(smiles).toMolfile());
    } catch {
      // The editor could not represent it at all; that is a gap in the input
      // path, not a scoring difference, so it is counted separately.
      unreadable++;
      continue;
    }

    const drawn = scoreOf(RDKit, app, queries, drawnSmiles);
    compared++;
    if (drawn !== direct) {
      disagreements.push({ id, smiles, drawnSmiles, direct, drawn });
      if (verbose) {
        console.log(`  ${id.padEnd(20)} typed=${direct?.toFixed(4)} drawn=${drawn?.toFixed(4)}`);
        console.log(`    typed ${smiles}\n    drawn ${drawnSmiles}`);
      }
    }
  }
  queries.forEach((q) => q.delete());

  console.log(`round-tripped ${compared} molecules through the editor's molfile writer`);
  if (unreadable) console.log(`${unreadable} could not be represented by the editor at all`);

  if (disagreements.length) {
    console.log(`\n${disagreements.length} score differently when drawn:`);
    for (const d of disagreements.slice(0, 10)) {
      console.log(`  ${d.id.padEnd(20)} typed=${d.direct?.toFixed(4)} drawn=${d.drawn?.toFixed(4)}`);
      console.log(`    typed ${d.smiles}\n    drawn ${d.drawnSmiles}`);
    }
  }

  const rate = ((100 * disagreements.length) / (compared || 1)).toFixed(2);
  console.log(`\nscore disagreements: ${disagreements.length}/${compared} (${rate}%)`);

  // Drawing a molecule must not change what it scores.
  process.exitCode = disagreements.length === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
