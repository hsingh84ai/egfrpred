/**
 * Records PaDEL's fingerprint output as a test fixture.
 *
 * Running PaDEL needs a JDK and about two minutes, so the ground truth is
 * captured once and committed. `npm test` then checks the browser
 * implementation against the fixture with no Java involved.
 *
 * All 881 bits are stored, not just the 49 the model uses, because the wider
 * set is what makes it possible to reason about *why* a bit behaves the way it
 * does -- notably which SMARTS constructs CDK can never match.
 *
 * PaDEL is not vendored here. Point PADEL_HOME at a checkout of the original
 * EGFRpred distribution (the directory holding PaDEL-Descriptor.jar, lib/ and
 * descriptors.xml):
 *
 *   PADEL_HOME=../egfrpred-legacy npm run fixture
 */

import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initRDKit from '@rdkit/rdkit/dist/RDKit_minimal.js';
import { buildCorpus } from './corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Stored gzipped: 3852 x 881 bits is 3.5 MB of text but under 200 KB compressed.
const OUT = join(ROOT, 'tests/fixtures/padel-bits.json.gz');

const PADEL = resolve(process.env.PADEL_HOME ?? join(ROOT, '..', 'egfrpred-legacy'));
const JAR = join(PADEL, 'PaDEL-Descriptor.jar');
const DESCRIPTORS = join(PADEL, 'descriptors.xml');

if (!existsSync(JAR) || !existsSync(DESCRIPTORS)) {
  console.error(
    `Could not find PaDEL-Descriptor.jar and descriptors.xml under ${PADEL}.\n\n` +
    `This script re-records the committed ground truth, so it needs the original\n` +
    `EGFRpred distribution. Set PADEL_HOME to point at it:\n\n` +
    `    PADEL_HOME=/path/to/egfrpred-legacy npm run fixture\n\n` +
    `Note that lib/ must sit next to the jar. Running \`npm test\` against the\n` +
    `committed fixture needs none of this.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'egfrpred-fixture-'));
try {
  const RDKit = await initRDKit();
  const corpus = buildCorpus(RDKit);
  console.log(`corpus: ${corpus.length} molecules`);

  const input = join(scratch, 'corpus.smi');
  writeFileSync(input, corpus.map((c) => `${c.smiles}\t${c.id}`).join('\n') + '\n');

  const csv = join(scratch, 'padel.csv');
  console.log('running PaDEL-Descriptor.jar ...');
  execFileSync('java', [
    '-Xmx2048M', '-jar', JAR,
    '-fingerprints', '-descriptortypes', DESCRIPTORS,
    '-dir', input, '-file', csv,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  const [header, ...rows] = readFileSync(csv, 'utf8').trim().split('\n');
  const width = header.split(',').length - 1;

  const byId = new Map();
  for (const row of rows) {
    const cells = row.split(',').map((c) => c.replace(/"/g, ''));
    // Store as a bit string: 881 characters is far more compact in JSON than an
    // array, and stays readable in a diff.
    let bits = '';
    for (let i = 1; i <= width; i++) bits += cells[i] === '1' ? '1' : '0';
    byId.set(cells[0], bits);
  }

  const molecules = corpus
    .filter((c) => byId.has(c.id))
    .map((c) => ({ id: c.id, smiles: c.smiles, bits: byId.get(c.id) }));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, gzipSync(JSON.stringify({
    source: 'PaDEL-Descriptor.jar -fingerprints -descriptortypes descriptors.xml',
    bitCount: width,
    molecules,
  })));
  console.log(`wrote ${molecules.length} molecules x ${width} bits -> ${OUT}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
