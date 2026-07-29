/**
 * End-to-end prediction: SMILES text in, per-molecule results out.
 *
 * This is the whole pipeline the original shell script ran across Java and
 * Python, now in one browser-side pass:
 *   parse SMILES -> 49 PubChem bits -> random forest -> score and label.
 */

import type { RDKitModule, JSMol } from '@rdkit/rdkit';
import { compileQueries, computeBits } from './fingerprint/pubchem';
import { DECISION_THRESHOLD, MODEL_BITS, label, score } from './model/forest';

export interface Prediction {
  id: string;
  smiles: string;
  /** Mean P(anti-EGFR) over the forest, or null when the SMILES failed to parse. */
  score: number | null;
  label: string;
  error?: string;
}

/**
 * Parses the .smi format the original tool accepted: one molecule per line, as
 * `<smiles>` optionally followed by whitespace and an identifier. Blank lines
 * and `#` comments are skipped, and unnamed molecules are numbered so every row
 * has a stable id.
 */
export function parseInput(text: string): { id: string; smiles: string }[] {
  const out: { id: string; smiles: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [smiles, ...rest] = line.split(/\s+/);
    out.push({ smiles, id: rest.join(' ') || `Mol_${String(out.length + 1).padStart(3, '0')}` });
  }
  return out;
}

/**
 * Scores every molecule. `onProgress` is called as rows complete so a long
 * batch can render incrementally instead of freezing the page.
 */
export function predictAll(
  RDKit: RDKitModule,
  molecules: { id: string; smiles: string }[],
  onProgress?: (done: number, total: number) => void,
): Prediction[] {
  const queries = compileQueries(RDKit, MODEL_BITS);
  const results: Prediction[] = [];

  try {
    for (const { id, smiles } of molecules) {
      let mol: JSMol | null = null;
      try {
        mol = RDKit.get_mol(smiles);
        if (!mol || !mol.is_valid()) throw new Error('not a valid SMILES string');
        const value = score(computeBits(mol, MODEL_BITS, queries));
        results.push({ id, smiles, score: value, label: label(value) });
      } catch (error) {
        results.push({
          id,
          smiles,
          score: null,
          label: 'Error',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        mol?.delete();
      }
      onProgress?.(results.length, molecules.length);
    }
  } finally {
    queries.forEach((q) => q.delete());
  }

  return results;
}

/** Reproduces the original tool's output file, byte format included. */
export function toCSV(results: Prediction[]): string {
  const lines = ['#Molecule_ID,Prediction,Prediction_score'];
  for (const r of results) {
    lines.push(`${r.id},${r.label},${r.score === null ? '' : r.score.toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}

export { DECISION_THRESHOLD };
