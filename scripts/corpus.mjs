/**
 * Builds the SMILES corpus used to validate the browser fingerprint against
 * PaDEL. Coverage matters more than size: a bit that is never set in the corpus
 * is a bit the comparison cannot check.
 *
 * So the corpus is deliberately stacked with cases that exercise the ten
 * non-SMARTS bits the model uses, which are the ones whose CDK semantics are
 * hardest to reproduce:
 *
 *   bit   2  >= 16 hydrogens                 -> long chains, steroids
 *   bit  17  >= 8 nitrogens                  -> polyamines, purines, porphyrins
 *   bit 115  any 3-membered ring             -> cyclopropanes, epoxides
 *   bit 118  saturated/aromatic 3-ring with a heteroatom
 *   bits 187/194  2+ and 3+ saturated/aromatic N-containing 6-rings
 *   bit 199  4+ six-membered rings           -> steroids, fused arenes, cages
 *   bits 258/260/262  2+, 3+, 4+ hetero-aromatic rings of any size
 *
 * Cage systems (adamantane, cubane, bicyclics) are included on purpose: their
 * smallest-ring set is ambiguous, and that is exactly where a symmetrised SSSR
 * can report more rings than CDK's SSSRFinder does.
 */

/** Ring systems carrying one substitution point, marked {R}. */
const SCAFFOLDS = [
  'c1ccccc1{R}', 'c1ccncc1{R}', 'c1cnccn1{R}', 'c1ccc2ccccc2c1{R}',
  'c1ccc2[nH]ccc2c1{R}', 'c1ccc2ncccc2c1{R}',
  'C1CCCCC1{R}', 'C1CCNCC1{R}', 'C1COCCN1{R}', 'C1CCOC1{R}',
  'c1ccsc1{R}', 'c1ccoc1{R}', 'c1c[nH]cn1{R}',
  'C1CC1{R}', 'C1CO1{R}', 'C1CN1{R}', 'C1CS1{R}',
  'C1CC2CCC1CC2{R}', 'C1C2CC3CC1CC(C2)C3{R}',
  'c1ccc2c(c1)ccc1ccccc12{R}',
];

const SUBSTITUENTS = [
  '', 'N', 'O', 'Cl', 'Br', 'F', 'S', 'C#N', 'C(=O)N', 'C(=O)O', 'OC',
  'S(=O)(=O)N', 'CCCCCCCC', 'CCCCCCCCCCCCCC', 'N(C)C', 'NC(=O)C',
  'c1ccccc1', 'NCCN', 'OCCN', 'C=C', 'C#C', 'NN', 'NC(=N)N', 'SC',
  'CC(C)C', 'OCCOCC', 'NC1CC1', 'C1CO1', 'Nc1ccccc1', 'Oc1ccccc1',
];

/** Linkers used to fuse two scaffolds into larger, multi-ring molecules. */
const LINKERS = ['', 'C', 'CC', 'N', 'O', 'S', 'NC(=O)', 'C(=O)N', 'C=C', 'OCCO', 'NCCN'];

/**
 * Hard cases, mostly chosen to drive the ring and element-count bits into
 * ranges the combinatorial set will not reach on its own.
 */
const CURATED = [
  // Cages and fused systems: ambiguous smallest-ring sets.
  ['adamantane', 'C1C2CC3CC1CC(C2)C3'],
  ['cubane', 'C12C3C4C1C5C4C3C25'],
  ['bicyclo222octane', 'C1CC2CCC1CC2'],
  ['norbornane', 'C1CC2CCC1C2'],
  ['prismane', 'C12C3C1C1C3C21'],
  ['decalin', 'C1CCC2CCCCC2C1'],
  ['anthracene', 'c1ccc2cc3ccccc3cc2c1'],
  ['naphthacene', 'c1ccc2cc3cc4ccccc4cc3cc2c1'],
  ['pyrene', 'c1cc2ccc3cccc4ccc(c1)c2c34'],
  ['coronene', 'c1cc2ccc3ccc4ccc5ccc6ccc1c1c2c3c4c5c61'],
  ['cyclophane', 'C1Cc2ccccc2CCc2ccccc21'],
  // Steroids: many six-rings plus high hydrogen counts.
  ['cholesterol', 'CC(C)CCCC(C)C1CCC2C1(CCC1C2CC=C2C1(CCC(C2)O)C)C'],
  ['estradiol', 'CC12CCC3c4ccc(O)cc4CCC3C1CCC2O'],
  ['cortisone', 'CC12CCC(=O)C=C1CCC1C2C(=O)CC2(C)C1CCC2(O)C(=O)CO'],
  // Nitrogen-rich: bit 17 and the N-containing ring bits.
  ['melamine', 'Nc1nc(N)nc(N)n1'],
  ['guanine', 'Nc1nc2[nH]cnc2c(=O)[nH]1'],
  ['adenine', 'Nc1ncnc2[nH]cnc12'],
  ['caffeine', 'Cn1cnc2c1c(=O)n(C)c(=O)n2C'],
  ['folate', 'Nc1nc2ncc(CNc3ccc(C(=O)NC(CCC(=O)O)C(=O)O)cc3)nc2c(=O)[nH]1'],
  ['porphine', 'c1cc2cc3ccc(cc4ccc(cc5ccc(cc1[nH]2)[nH]5)n4)[nH]3'],
  ['spermine', 'NCCCNCCCCNCCCN'],
  ['cyclen', 'C1CNCCNCCNCCN1'],
  ['bipyridine', 'c1ccc(-c2ccccn2)nc1'],
  ['terpyridine', 'c1ccc(-c2cccc(-c3ccccn3)n2)nc1'],
  ['quaterpyridine', 'c1ccnc(-c2cccc(-c3cccc(-c4ccccn4)n3)n2)c1'],
  ['tris_imidazolyl_triazine', 'c1cn(-c2nc(-n3ccnc3)nc(-n3ccnc3)n2)cn1'],
  ['piperazine_bis_pyridine', 'c1ccnc(N2CCN(c3ccccn3)CC2)c1'],
  ['tetra_piperidine', 'C1CN(C2CCN(C3CCN(C4CCNCC4)CC3)CC2)CC1'],
  // Long chains: bit 2.
  ['hexadecane', 'CCCCCCCCCCCCCCCC'],
  ['stearic_acid', 'CCCCCCCCCCCCCCCCCC(=O)O'],
  // Real EGFR inhibitors -- the model's actual domain.
  ['gefitinib', 'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1'],
  ['erlotinib', 'C#Cc1cccc(Nc2ncnc3cc(OCCOC)c(OCCOC)cc23)c1'],
  ['lapatinib', 'CS(=O)(=O)CCNCc1ccc(-c2ccc3ncnc(Nc4ccc(OCc5cccc(F)c5)c(Cl)c4)c3c2)o1'],
  ['afatinib', 'CN(C)CC=CC(=O)Nc1cc2c(Nc3ccc(F)c(Cl)c3)ncnc2cc1OC1CCOC1'],
  ['osimertinib', 'C=CC(=O)Nc1cc(Nc2nccc(-c3cn(C)c4ccccc34)n2)c(OC)cc1N(C)CCN(C)C'],
  ['imatinib', 'Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1'],
  // Assorted heteroatoms and charge states.
  ['sulfathiazole', 'Nc1ccc(S(=O)(=O)Nc2nccs2)cc1'],
  ['penicillin_g', 'CC1(C)SC2C(NC(=O)Cc3ccccc3)C(=O)N2C1C(=O)O'],
  ['glucose', 'OCC1OC(O)C(O)C(O)C1O'],
  ['nitrobenzene', 'O=[N+]([O-])c1ccccc1'],
  ['betaine', 'C[N+](C)(C)CC(=O)[O-]'],
  ['thiophene_fused', 'c1csc2c1ccc1ccsc12'],
  ['epoxide_chain', 'CCCCCCCCC1CO1'],
  ['aziridine_aryl', 'c1ccc(N2CC2)cc1'],
  ['thiirane', 'C1CS1'],
  ['tetrazole', 'c1nnn[nH]1'],
  ['macrocycle', 'C1CCCCCCCCCCCCCCC1'],
  ['crown_ether', 'C1COCCOCCOCCOCCOCCO1'],
];

/** Yields `{ id, smiles }`, de-duplicated and validated through RDKit. */
export function buildCorpus(RDKit) {
  const seen = new Set();
  const out = [];

  const add = (id, smiles) => {
    let mol;
    try {
      mol = RDKit.get_mol(smiles);
    } catch {
      return;
    }
    if (!mol) return;
    try {
      if (!mol.is_valid()) return;
      const canonical = mol.get_smiles();
      if (seen.has(canonical)) return;
      seen.add(canonical);
      out.push({ id, smiles });
    } finally {
      mol.delete();
    }
  };

  for (const [name, smiles] of CURATED) add(name, smiles);

  let n = 0;
  for (const scaffold of SCAFFOLDS) {
    for (const substituent of SUBSTITUENTS) {
      add(`sub_${n++}`, scaffold.replace('{R}', substituent));
    }
  }

  // Scaffold-linker-scaffold, so the corpus contains plenty of molecules with
  // three or more rings -- the range where bits 187/194/199/258/260/262 live.
  let m = 0;
  for (const left of SCAFFOLDS) {
    for (const right of SCAFFOLDS) {
      for (const linker of LINKERS) {
        add(`pair_${m++}`, left.replace('{R}', linker + right.replace('{R}', '')));
      }
    }
  }
  return out;
}
