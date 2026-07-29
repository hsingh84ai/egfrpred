/**
 * Bridges the structure editor to the rest of the pipeline.
 *
 * The editor hands back a molfile, and RDKit reads molfiles, so a drawn
 * structure is converted to a canonical SMILES and appended to the text input.
 * From there it takes exactly the same path as anything typed or loaded from a
 * .smi file: nothing downstream knows the difference, so drawing cannot produce
 * a different score from the equivalent SMILES. scripts/validate_sketcher.mjs
 * checks that over the whole corpus.
 */

import type { RDKitModule } from '@rdkit/rdkit';

/** Thrown for a sketch the pipeline cannot take; the message is shown as-is. */
export class SketchError extends Error {}

/**
 * Canonical SMILES for a molfile, or a SketchError explaining why not.
 *
 * An empty editor is the common case here -- opening the sketcher and pressing
 * add without drawing yields a structurally valid molfile with no atoms, which
 * RDKit accepts and renders as the empty string.
 */
export function molfileToSmiles(rdkit: RDKitModule, molfile: string): string {
  const mol = rdkit.get_mol(molfile);
  if (!mol) throw new SketchError('that structure could not be read');
  try {
    if (!mol.is_valid()) throw new SketchError('that structure is not a valid molecule');
    const smiles = mol.get_smiles();
    if (!smiles) throw new SketchError('nothing drawn yet');
    return smiles;
  } finally {
    mol.delete();
  }
}

/** Append a SMILES line to the textarea's existing contents. */
export function appendMolecule(input: string, smiles: string, name: string): string {
  const body = input.replace(/\s+$/, '');
  return body ? `${body}\n${smiles}\t${name}` : `${smiles}\t${name}`;
}
