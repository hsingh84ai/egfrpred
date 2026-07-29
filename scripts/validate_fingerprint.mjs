/**
 * Checks the browser fingerprint against PaDEL's recorded output.
 *
 * The fixture in tests/fixtures was produced by running the original
 * PaDEL-Descriptor.jar (see make_fixture.mjs), so this compares the port
 * against the exact tool the model was trained with -- without needing a JDK.
 *
 * Reports, per bit, how often the two disagree, and how often the disagreement
 * changes the final call. Bit-level noise only matters if it moves predictions.
 *
 * Usage:  npm test
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import initRDKit from '@rdkit/rdkit/dist/RDKit_minimal.js';

const APP = fileURLToPath(new URL('..', import.meta.url));
const verbose = process.argv.includes('--verbose');

async function loadAppModules(scratch) {
  const entry = join(scratch, 'entry.mjs');
  // esbuild resolves absolute paths but not file:// URLs, and a Windows path's
  // backslashes would be read as escapes inside the generated import. Forward
  // slashes are accepted on both platforms.
  const spec = (rel) => JSON.stringify(join(APP, rel).replace(/\\/g, '/'));
  writeFileSync(entry, `
    export { computeBits, compileQueries } from ${spec('src/lib/fingerprint/pubchem.ts')};
    export { MODEL_BITS, score, label } from ${spec('src/lib/model/forest.ts')};
  `);
  const outfile = join(scratch, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm',
                platform: 'node', external: ['@rdkit/rdkit'], logLevel: 'warning' });
  // Nor is a Windows absolute path a valid ESM specifier: Node reads the drive
  // letter as a URL scheme and rejects it. import() takes a file:// URL.
  return import(pathToFileURL(outfile).href);
}

const scratch = mkdtempSync(join(tmpdir(), 'egfrpred-test-'));
try {
  const RDKit = await initRDKit();
  const app = await loadAppModules(scratch);
  const fixture = JSON.parse(
    gunzipSync(readFileSync(join(APP, 'tests/fixtures/padel-bits.json.gz'))).toString('utf8'));

  const bits = app.MODEL_BITS;
  const queries = app.compileQueries(RDKit, bits);

  const mismatches = new Map(bits.map((b) => [b, []]));
  const positives = new Map(bits.map((b) => [b, 0]));
  let compared = 0;
  let labelDisagreements = 0;
  let worstScoreGap = 0;

  for (const { id, smiles, bits: truthBits } of fixture.molecules) {
    const mol = RDKit.get_mol(smiles);
    if (!mol) continue;
    try {
      const actual = app.computeBits(mol, bits, queries);
      const expected = bits.map((b) => (truthBits[b] === '1' ? 1 : 0));
      compared++;

      bits.forEach((bit, i) => {
        if (expected[i]) positives.set(bit, positives.get(bit) + 1);
        if (expected[i] !== actual[i]) mismatches.get(bit).push({ id, smiles });
      });

      // What the bit differences actually cost at the output.
      const truthScore = app.score(expected);
      const ourScore = app.score(actual);
      worstScoreGap = Math.max(worstScoreGap, Math.abs(truthScore - ourScore));
      if (app.label(truthScore) !== app.label(ourScore)) {
        labelDisagreements++;
        if (verbose) {
          console.log(`  label differs: ${id.padEnd(20)} padel=${truthScore.toFixed(4)} js=${ourScore.toFixed(4)}  ${smiles}`);
        }
      }
    } finally {
      mol.delete();
    }
  }
  queries.forEach((q) => q.delete());

  console.log(`compared ${compared} molecules against PaDEL\n`);

  let failing = 0;
  const untested = [];
  for (const bit of bits) {
    const bad = mismatches.get(bit);
    if (positives.get(bit) === 0 && bad.length === 0) untested.push(bit);
    if (bad.length === 0) continue;
    failing++;
    const rate = ((100 * bad.length) / compared).toFixed(2);
    console.log(`bit ${String(bit).padStart(3)}: ${String(bad.length).padStart(4)} disagree (${rate}%)`);
    for (const m of bad.slice(0, 3)) console.log(`        ${m.id.padEnd(20)} ${m.smiles}`);
  }

  console.log(`\n${bits.length - failing}/${bits.length} bits match PaDEL exactly`);
  console.log(`label disagreements: ${labelDisagreements}/${compared} ` +
              `(${((100 * labelDisagreements) / compared).toFixed(2)}%)`);
  console.log(`largest score difference: ${worstScoreGap.toFixed(4)}`);
  if (untested.length) {
    console.log(`\nnote: never set by PaDEL in this corpus, so only the zero case is ` +
                `checked: ${untested.join(', ')}`);
  }

  // The gate is prediction agreement: a bit that never moves a call is noise,
  // and a bit that does is a bug regardless of how rare it is.
  process.exitCode = labelDisagreements === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
