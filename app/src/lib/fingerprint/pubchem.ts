/**
 * PubChem/CDK fingerprint bits, computed in the browser via RDKit.
 *
 * The original pipeline shells out to PaDEL-Descriptor.jar, which delegates to
 * CDK's PubchemFingerprinter, to produce all 881 bits and then keeps 49 of them.
 * This module computes only those 49 directly. The bit definitions in
 * `bits.json` are not hand-transcribed -- they are scraped out of the CDK
 * bytecode by tools/extract_pubchem_bits.py, so they are the same predicates the
 * model was trained against.
 *
 * The three bit families and how each maps onto RDKit:
 *
 *   element  count atoms of one element, compared against a threshold. CDK
 *            counts container atoms, and PaDEL hands it a molecule with
 *            hydrogens made explicit, so implicit H must be added back here.
 *   ring     a predicate over CDK's SSSR ring set. RDKit's ring info gives the
 *            ring atoms; bond orders and aromatic flags come from the same JSON.
 *   smarts   presence of a substructure. All 49 selected bits test for one or
 *            more matches, so a single-match search is enough.
 */

import type { RDKitModule, JSMol } from '@rdkit/rdkit';
import bitDefinitions from './bits.json';

export type BitDefinition =
  | { kind: 'element'; element: string; min: number }
  | { kind: 'ring'; predicate: string; size: number | null; min: number }
  | { kind: 'smarts'; smarts: string; min: number };

const DEFINITIONS = bitDefinitions as unknown as Record<string, BitDefinition>;

const ATOMIC_NUMBERS: Record<string, number> = {
  H: 1, B: 5, C: 6, N: 7, O: 8, F: 9, Na: 11, Mg: 12, Al: 13, Si: 14,
  P: 15, S: 16, Cl: 17, K: 19, Ca: 20, Br: 35, I: 53, Li: 3, Be: 4,
};

const CARBON = 6;
const HYDROGEN = 1;

/** One molecule, flattened out of RDKit's CommonChem JSON. */
interface MolGraph {
  /** Atomic number per atom; RDKit omits `z` for carbon. */
  elements: number[];
  /** Implicit hydrogens per atom, on top of any explicit H atoms. */
  implicitHs: number[];
  bonds: { a: number; b: number; order: number; aromatic: boolean }[];
  /** Bond index by unordered atom pair, for walking ring bonds. */
  bondBetween: Map<string, number>;
  /** SSSR ring atom indices, in cycle order. */
  rings: number[][];
}

/**
 * Reduces RDKit's ring set to a true SSSR of CDK's size.
 *
 * RDKit reports a *symmetrised* SSSR, which deliberately keeps extra symmetry-
 * equivalent rings: adamantane comes back with four six-rings where CDK's
 * SSSRFinder returns three. That difference is directly visible in bit 199
 * ("four or more six-membered rings"), which PaDEL leaves clear on adamantane.
 *
 * A minimum cycle basis has exactly `bonds - atoms + components` rings, and
 * every valid choice of basis has the same multiset of ring sizes -- so taking
 * smallest-first while skipping rings that are linearly dependent (over GF(2)
 * in bond space) on those already kept reproduces CDK's ring-size profile.
 */
function reduceToSSSR(rings: number[][], graph: Omit<MolGraph, 'rings'>): number[][] {
  const atomCount = graph.elements.length;
  const bondCount = graph.bonds.length;

  // Components, so disconnected inputs (salts, mixtures) get the right count.
  const parent = Array.from({ length: atomCount }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const bond of graph.bonds) parent[find(bond.a)] = find(bond.b);
  let components = 0;
  for (let i = 0; i < atomCount; i++) if (find(i) === i) components++;

  const target = bondCount - atomCount + components;
  if (rings.length <= target) return rings;

  // Gaussian elimination over GF(2); each ring is a bitset of its bond indices,
  // and `basis` is keyed by each row's pivot bit.
  const words = Math.ceil(bondCount / 32) || 1;
  const basis = new Map<number, Uint32Array>();
  const kept: number[][] = [];

  for (const ring of [...rings].sort((a, b) => a.length - b.length)) {
    if (kept.length === target) break;

    const vector = new Uint32Array(words);
    for (let i = 0; i < ring.length; i++) {
      const bond = graph.bondBetween.get(pairKey(ring[i], ring[(i + 1) % ring.length]));
      if (bond !== undefined) vector[bond >>> 5] ^= 1 << (bond & 31);
    }

    let pivot = pivotBit(vector);
    while (pivot >= 0 && basis.has(pivot)) {
      const row = basis.get(pivot)!;
      for (let w = 0; w < words; w++) vector[w] ^= row[w];
      pivot = pivotBit(vector);
    }
    if (pivot < 0) continue; // dependent on rings already kept; CDK drops it

    basis.set(pivot, vector);
    kept.push(ring);
  }
  return kept;
}

/** Index of the lowest set bit, or -1 when the vector is zero. */
function pivotBit(vector: Uint32Array): number {
  for (let w = 0; w < vector.length; w++) {
    if (vector[w]) return w * 32 + (31 - Math.clz32(vector[w] & -vector[w]));
  }
  return -1;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function readGraph(mol: JSMol): MolGraph {
  const parsed = JSON.parse(mol.get_json());
  const molecule = parsed.molecules[0];
  const extension =
    (molecule.extensions ?? []).find((e: any) => e.name === 'rdkitRepresentation') ?? {};

  const aromaticBonds = new Set<number>(extension.aromaticBonds ?? []);
  const elements: number[] = molecule.atoms.map((a: any) => a.z ?? CARBON);
  const implicitHs: number[] = molecule.atoms.map((a: any) => a.impHs ?? 0);

  const bonds = molecule.bonds.map((b: any, i: number) => ({
    a: b.atoms[0],
    b: b.atoms[1],
    // CommonChem omits `bo` for single bonds. CDK keeps Kekule orders and flags
    // aromaticity separately, which is exactly the shape RDKit reports here.
    order: b.bo ?? 1,
    aromatic: aromaticBonds.has(i),
  }));

  const bondBetween = new Map<string, number>();
  bonds.forEach((b: MolGraph['bonds'][number], i: number) =>
    bondBetween.set(pairKey(b.a, b.b), i),
  );

  const partial = { elements, implicitHs, bonds, bondBetween };
  return { ...partial, rings: reduceToSSSR(extension.atomRings ?? [], partial) };
}

function ringBonds(graph: MolGraph, ring: number[]): MolGraph['bonds'] {
  const out: MolGraph['bonds'] = [];
  for (let i = 0; i < ring.length; i++) {
    const index = graph.bondBetween.get(pairKey(ring[i], ring[(i + 1) % ring.length]));
    if (index !== undefined) out.push(graph.bonds[index]);
  }
  return out;
}

// CDK's isRingSaturated: every bond in the ring is a single bond. Aromatic rings
// carry alternating Kekule orders, so they fail this and are caught by
// isAromaticRing instead -- the "SaturatedOrAromatic" predicates test both.
const isSaturated = (bonds: MolGraph['bonds']) => bonds.every((b) => b.order === 1);
const isAromatic = (bonds: MolGraph['bonds']) => bonds.every((b) => b.aromatic);

/** CDK treats anything that is not carbon and not hydrogen as a heteroatom. */
const isHetero = (z: number) => z !== CARBON && z !== HYDROGEN;

function countRings(graph: MolGraph, predicate: string, size: number | null): number {
  let total = 0;
  for (const ring of graph.rings) {
    if (size !== null && ring.length !== size) continue;
    const elements = ring.map((i) => graph.elements[i]);
    const bonds = ringBonds(graph, ring);
    const saturatedOrAromatic = isSaturated(bonds) || isAromatic(bonds);

    let hit: boolean;
    switch (predicate) {
      case 'countAnyRing':
        hit = true;
        break;
      case 'countAromaticRing':
        hit = isAromatic(bonds);
        break;
      case 'countHeteroAromaticRing':
        hit = !elements.every((z) => z === CARBON) && isAromatic(bonds);
        break;
      case 'countSaturatedOrAromaticCarbonOnlyRing':
        hit = saturatedOrAromatic && elements.every((z) => z === CARBON);
        break;
      case 'countSaturatedOrAromaticNitrogenContainingRing':
        hit = saturatedOrAromatic && elements.some((z) => z === 7);
        break;
      case 'countSaturatedOrAromaticHeteroContainingRing':
        hit = saturatedOrAromatic && elements.some(isHetero);
        break;
      case 'countUnsaturatedCarbonOnlyRing':
        hit = !isSaturated(bonds) && !isAromatic(bonds) && elements.every((z) => z === CARBON);
        break;
      case 'countUnsaturatedNitrogenContainingRing':
        hit = !isSaturated(bonds) && !isAromatic(bonds) && elements.some((z) => z === 7);
        break;
      case 'countUnsaturatedHeteroContainingRing':
        hit = !isSaturated(bonds) && !isAromatic(bonds) && elements.some(isHetero);
        break;
      default:
        throw new Error(`unknown ring predicate ${predicate}`);
    }
    if (hit) total++;
  }
  return total;
}

function countElement(graph: MolGraph, element: string): number {
  const z = ATOMIC_NUMBERS[element];
  if (z === undefined) throw new Error(`unknown element ${element}`);
  // CDK's CountElements walks the container's *atoms*, and PaDEL only calls
  // convertImplicitToExplicitHydrogens under its -addhydrogens flag, which the
  // original EGFRpred command line never passes. So hydrogens exist as implicit
  // counts but not as atoms, and the hydrogen element bits are never set --
  // PaDEL leaves bit 2 clear even for hexadecane. Implicit H are deliberately
  // not added back here; doing so would set a bit the model never saw set.
  let total = 0;
  for (const e of graph.elements) if (e === z) total++;
  return total;
}

/**
 * Computes selected PubChem bits for one molecule.
 *
 * `queries` caches compiled SMARTS across molecules; building them is far more
 * expensive than matching, and a batch run reuses the same ~39 patterns.
 */
export function computeBits(
  mol: JSMol,
  bitIds: number[],
  queries: Map<string, JSMol>,
): Uint8Array {
  const graph = readGraph(mol);
  const out = new Uint8Array(bitIds.length);

  bitIds.forEach((bit, i) => {
    const def = DEFINITIONS[String(bit)];
    if (!def) throw new Error(`no definition for PubChem bit ${bit}`);

    let count: number;
    switch (def.kind) {
      case 'element':
        count = countElement(graph, def.element);
        break;
      case 'ring':
        count = countRings(graph, def.predicate, def.size);
        break;
      case 'smarts': {
        if (isUnmatchableInCDK(def.smarts)) {
          count = 0;
          break;
        }
        const query = queries.get(def.smarts);
        if (!query) throw new Error(`SMARTS not compiled: ${def.smarts}`);
        // Every selected bit needs only presence, so stop at the first match
        // rather than enumerating (and de-duplicating) all of them.
        count = mol.get_substruct_match(query) === '{}' ? 0 : 1;
        break;
      }
    }
    out[i] = count >= def.min ? 1 : 0;
  });

  return out;
}

/**
 * True when CDK 1.4.6 can never match this SMARTS, so PaDEL always reports the
 * bit as zero.
 *
 * A negated hydrogen-count primitive works on the first atom of a pattern but
 * never matches on any later atom. Measured over the 618 SMARTS bits against
 * PaDEL's own output for 3852 molecules: all 35 patterns carrying `!H<n>` on a
 * non-root atom are never set, with no counterexamples, while 34 of the 42 that
 * carry one only on the root atom are set (the other 8 need elements the corpus
 * lacks, such as lithium).
 *
 * Five of the model's 49 inputs are in that dead set:
 *
 *   513  [#16]:[#6]:[#6&!H0]        522  [#6]-,:[#7]-,:[#7&!H0]
 *   528  [#7&!H0]-,:[#6&!H0]        540  [#6]-,:[#7]-,:[#6&!H0]
 *   571  [#6&!H0]-,:[#8&!H0]
 *
 * RDKit matches all five happily, so evaluating them honestly would set bits the
 * model was never trained to see -- bit 540 alone would fire on 70% of
 * molecules. Reproducing the original tool means reproducing its bug.
 */
export function isUnmatchableInCDK(smarts: string): boolean {
  const atoms = smarts.match(/\[[^\]]*\]/g) ?? [];
  return atoms.slice(1).some((atom) => /!H\d/.test(atom));
}

/**
 * Rewrites CDK's reading of the aromatic-bond primitive into RDKit's.
 *
 * In RDKit, `:` means the *bond* carries an aromatic flag. CDK 1.4.6 instead
 * treats it as "both atoms are aromatic", so it also matches the plain single
 * bond joining two rings. PaDEL sets bit 386 ([#6](:c)(:c)(:n)) on
 * 2,2'-bipyridine, where no ring atom has three aromatic *bonds* -- the third
 * has to be the inter-ring bond -- which only makes sense under CDK's reading.
 *
 * So each `:` becomes `~` (any bond) with both endpoints constrained aromatic.
 * `-,:` is left alone: "single or aromatic bond" and "single bond or two
 * aromatic atoms" differ only for a double bond between two aromatic atoms.
 */
export function translateSmarts(smarts: string): string {
  const tokens = smarts.match(/\[[^\]]*\]|-,:|=,:|Cl|Br|[a-z]|[A-Z]|./g) ?? [];
  const isAtom = (t: string) => /^\[/.test(t) || /^(Cl|Br|[A-Za-z])$/.test(t);

  // Walk the pattern the way a SMILES reader does, tracking which atom the
  // current branch hangs off, so `(:c)` attaches to the atom before the branch
  // rather than to whatever token happens to precede it.
  const aromatic = new Set<number>();
  const branches: number[] = [];
  let previous = -1;
  let pendingBond = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '(') { branches.push(previous); continue; }
    if (token === ')') { previous = branches.pop() ?? -1; continue; }
    if (token === ':') { pendingBond = true; continue; }
    if (!isAtom(token)) { pendingBond = false; continue; }
    if (pendingBond) {
      if (previous >= 0) aromatic.add(previous);
      aromatic.add(i);
      pendingBond = false;
    }
    previous = i;
  }
  if (!aromatic.size) return smarts;

  return tokens
    .map((token, i) => {
      if (token === ':') return '~';
      if (!aromatic.has(i)) return token;
      // Lowercase organic-subset symbols are already aromatic-only.
      if (/^[a-z]$/.test(token)) return token;
      if (token.startsWith('[')) return `${token.slice(0, -1)};a]`;
      return token;
    })
    .join('');
}

/** Compiles every SMARTS the given bits need. Callers must delete these. */
export function compileQueries(RDKit: RDKitModule, bitIds: number[]): Map<string, JSMol> {
  const queries = new Map<string, JSMol>();
  for (const bit of bitIds) {
    const def = DEFINITIONS[String(bit)];
    if (def?.kind !== 'smarts' || queries.has(def.smarts)) continue;
    if (isUnmatchableInCDK(def.smarts)) continue;
    const translated = translateSmarts(def.smarts);
    const query = RDKit.get_qmol(translated);
    if (!query) throw new Error(`RDKit rejected SMARTS ${translated} (from ${def.smarts})`);
    queries.set(def.smarts, query);
  }
  return queries;
}

export { DEFINITIONS as BIT_DEFINITIONS };
