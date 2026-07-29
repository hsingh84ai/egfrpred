/**
 * Random forest inference over binary fingerprint bits.
 *
 * `forest.json` is produced by tools/export_model.py from the original
 * scikit-learn 0.15.2 pickle. Because all 49 inputs are fingerprint bits, every
 * split in the original model sits at 0.5, so a node's test collapses to
 * "is this bit set" and no thresholds are stored.
 */

import forestData from './forest.json';

interface Tree {
  /** Child node index when the split bit is 0; -1 marks a leaf. */
  l: number[];
  /** Child node index when the split bit is 1. */
  r: number[];
  /** Index into `bits` that this node splits on; -1 at leaves. */
  f: number[];
  /** P(anti-EGFR) at each node; only leaf entries are read. */
  p: number[];
}

interface Forest {
  /** PubChem fingerprint bit numbers, in the order the model expects them. */
  bits: number[];
  classes: number[];
  /** Score at or above which a molecule is called anti-EGFR. */
  threshold: number;
  trees: Tree[];
}

const FOREST = forestData as Forest;

export const MODEL_BITS: number[] = FOREST.bits;
export const DECISION_THRESHOLD: number = FOREST.threshold;

/**
 * Mean P(anti-EGFR) across the ensemble.
 *
 * `features` must be one 0/1 value per entry of MODEL_BITS, in that order.
 */
export function score(features: ArrayLike<number>): number {
  if (features.length !== FOREST.bits.length) {
    throw new Error(`expected ${FOREST.bits.length} features, got ${features.length}`);
  }

  let total = 0;
  for (const tree of FOREST.trees) {
    let node = 0;
    // sklearn sends `x <= threshold` left, so an unset bit takes the left child.
    while (tree.f[node] >= 0) {
      node = features[tree.f[node]] ? tree.r[node] : tree.l[node];
    }
    total += tree.p[node];
  }
  return total / FOREST.trees.length;
}

export function label(value: number): string {
  // The original compares the score as a *string* (`if sa >= "0.2"`), which
  // happens to agree with a numeric test for every score it can produce, but
  // only by accident. Compare numbers.
  return value >= DECISION_THRESHOLD ? 'Anti-EGFR' : 'Non-anti-EGFR';
}
