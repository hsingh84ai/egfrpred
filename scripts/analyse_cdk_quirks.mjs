/**
 * Evidence for the CDK SMARTS quirk encoded in pubchem.ts.
 *
 * Five of the model's 49 inputs are SMARTS that RDKit matches readily but PaDEL
 * never sets. `isUnmatchableInCDK` hard-codes that behaviour, which is a strong
 * claim -- so this script re-derives it from the recorded PaDEL output over all
 * 618 SMARTS bits, not just the 49 in play.
 *
 * The pattern: a negated hydrogen-count primitive (`!H<n>`) matches on the first
 * atom of a query but never on any later one.
 *
 * Usage:  npm run analyse
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));

const fixture = JSON.parse(
  gunzipSync(readFileSync(join(APP, 'tests/fixtures/padel-bits.json.gz'))).toString('utf8'));
const definitions = JSON.parse(
  readFileSync(join(APP, 'src/lib/fingerprint/bits.json'), 'utf8'));

const total = fixture.molecules.length;
const timesSet = new Array(fixture.bitCount).fill(0);
for (const molecule of fixture.molecules) {
  for (let bit = 0; bit < fixture.bitCount; bit++) {
    if (molecule.bits[bit] === '1') timesSet[bit]++;
  }
}

const atomsOf = (smarts) => smarts.match(/\[[^\]]*\]/g) ?? [];
const negatesH = (atom) => /!H\d/.test(atom);

const groups = { 'negated H on a later atom': [], 'negated H on the first atom only': [], 'no negated H': [] };
for (let bit = 263; bit < fixture.bitCount; bit++) {
  const atoms = atomsOf(definitions[String(bit)].smarts);
  if (atoms.slice(1).some(negatesH)) groups['negated H on a later atom'].push(bit);
  else if (atoms.length && negatesH(atoms[0])) groups['negated H on the first atom only'].push(bit);
  else groups['no negated H'].push(bit);
}

console.log(`PaDEL output for ${total} molecules, across all ${fixture.bitCount - 263} SMARTS bits\n`);
for (const [name, bits] of Object.entries(groups)) {
  const dead = bits.filter((b) => timesSet[b] === 0);
  console.log(`${name.padEnd(34)} ${String(bits.length).padStart(3)} bits, ` +
              `${String(dead.length).padStart(3)} never set ` +
              `(${((100 * dead.length) / bits.length).toFixed(0)}%)`);
}

const live = groups['negated H on a later atom'].filter((b) => timesSet[b] > 0);
console.log(`\ncounterexamples (a later-atom !H bit that PaDEL does set): ` +
            `${live.length ? live.join(', ') : 'none'}`);

console.log('\nthe five affected model inputs:');
for (const bit of [513, 522, 528, 540, 571]) {
  console.log(`  ${bit}  set by PaDEL in ${timesSet[bit]}/${total}   ${definitions[String(bit)].smarts}`);
}

// A bit that is dead for a mundane reason (no molecule in the corpus contains
// lithium) is not evidence of a query bug, so separate the two.
const firstAtomDead = groups['negated H on the first atom only'].filter((b) => timesSet[b] === 0);
console.log(`\nfirst-atom !H bits that are also never set (corpus gaps, not the bug):`);
for (const bit of firstAtomDead) console.log(`  ${bit}  ${definitions[String(bit)].smarts}`);
