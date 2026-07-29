# EGFRpred

Predicts whether a molecule is an EGFR inhibitor from its SMILES string, using a
random forest over PubChem substructure fingerprints.

The tool now runs entirely in the browser. There is no Python, no Java, no
server, and no upload: the fingerprint, the model and the structure rendering all
execute client-side, so molecules never leave the machine they are typed on.

The original Python 2.7 / PaDEL pipeline is still in this repository and still
works; see [Legacy pipeline](#legacy-pipeline).

---

## Quick start

```bash
cd app
npm install
npm run dev          # http://localhost:5173
```

To produce a deployable static site:

```bash
npm run build        # -> app/build, ~7 MB, serve it from anywhere
```

`app/build` is plain files. Any static host works — GitHub Pages, Netlify, S3, or
`python3 -m http.server` in that directory. To serve from a subpath (as GitHub
Pages project sites do), set `BASE_PATH` at build time:

```bash
BASE_PATH=/egfrpred npm run build
```

Paste SMILES one per line, optionally followed by whitespace and a name, or load
a `.smi` file. Results can be downloaded as CSV in the same format the original
tool emitted:

```
#Molecule_ID,Prediction,Prediction_score
gefitinib,Anti-EGFR,0.5565
aspirin,Non-anti-EGFR,0.1604
```

---

## How it works

The original pipeline shelled out to a Java program and a pickled Python model:

```
.smi -> PaDEL-Descriptor.jar -> 881 PubChem bits -> keep 49 -> sklearn RF -> score
```

The browser version performs the same four steps:

| Step | Original | Now |
| --- | --- | --- |
| Parse SMILES | CDK (Java) | RDKit compiled to WebAssembly |
| 881-bit fingerprint | PaDEL-Descriptor.jar | only the 49 needed bits, computed directly |
| Feature selection | `imp-no`, read at runtime | baked into the exported model |
| Random forest | `cPickle` + scikit-learn 0.15.2 | 254 KB of JSON, ~50 KB gzipped |

Two things made this practical.

**The model is just arrays.** The `model` pickle can only be read by
scikit-learn 0.15.2 on Python 2.7, but that is a serialization problem, not a
modelling one. Substituting stub classes for every `sklearn.*` symbol lets a
modern Python read it with scikit-learn not installed at all
(`tools/export_model.py`). What comes out is 100 trees of plain arrays — and
because all 49 inputs are binary fingerprint bits, **every split threshold is
0.5**, so inference is bit tests and an average.

**Only 49 of the 881 bits are needed.** The bit definitions are not transcribed
by hand from the PubChem specification — `tools/extract_pubchem_bits.py`
disassembles CDK's `PubchemFingerprinter` and scrapes all 881 definitions out of
the bytecode, so the app tests the same predicates the model was trained on. Of
the 49 selected: 2 are element counts, 8 are SSSR ring predicates, and 39 are
SMARTS presence tests.

---

## Fidelity

The port is checked against the real `PaDEL-Descriptor.jar` over a 3852-molecule
corpus built to stress the ring and element-count bits (steroids, cages, fused
arenes, porphyrins, polyamines, and the marketed EGFR inhibitors):

```
48/49 bits match PaDEL exactly
label disagreements: 0/3852 (0.00%)
largest score difference: 0.0111
```

```bash
cd app
npm test             # against the recorded fixture; no JDK needed
npm run fixture      # re-record ground truth (needs a JDK; ~2 min)
npm run smoke        # drive the built site in a real browser
npm run analyse      # re-derive the CDK quirk described below
```

Reaching that required reproducing three behaviours of the original stack that
are arguably bugs. Since the model was *trained* on data the original stack
produced, matching it means matching those too.

**1. Hydrogens are never counted.** CDK counts hydrogen *atoms*, and PaDEL only
converts implicit hydrogens into atoms under its `-addhydrogens` flag, which the
original command line never passes. So bit 2 (">= 16 hydrogens") is never set —
not even for hexadecane. The app does not add them back.

**2. A CDK SMARTS bug kills five features.** A negated hydrogen-count primitive
(`!H0`) matches on the first atom of a pattern but never on any later atom.
Measured across all 618 SMARTS bits over the corpus: all 35 patterns carrying
`!H<n>` on a non-root atom are never set, with **no counterexamples**, while 34
of the 42 carrying one only on the root atom are set — the other 8 need elements
the corpus does not contain (Li, B, Al, Si, P, As). Five of the model's inputs
are in that dead set: bits 513, 522, 528, 540 and 571. RDKit matches all five
happily; bit 540 alone would fire on 70% of molecules. Evaluating them honestly
would feed the model bits it was never trained to see, so the app reproduces the
bug (`isUnmatchableInCDK`). Run `npm run analyse` to re-derive this.

**3. Ring counting and aromatic bonds differ from RDKit.**
RDKit returns a *symmetrised* SSSR — adamantane comes back with four six-rings
where CDK returns three, which is directly visible in bit 199 ("four or more
six-membered rings"). The app reduces RDKit's ring set to a true minimum cycle
basis. Separately, RDKit reads SMARTS `:` as "this bond is aromatic" while CDK
reads it as "both atoms are aromatic" — CDK also matches the plain single bond
joining two rings, which is why PaDEL sets bit 386 on 2,2'-bipyridine. The app
rewrites those patterns accordingly.

### Known deviation

One bit still differs: **bit 386** (`[#6](:c)(:c)(:n)`) on fused rings bearing an
exocyclic carbonyl — guanine, caffeine and folate in the corpus, 3 of 3852
molecules. RDKit's aromaticity model calls those rings aromatic; CDK's Hückel
detector does not. Closing it would mean porting CDK's aromaticity perception.
The measured cost is a score shift of at most 0.0111, against a decision
threshold of 0.20, and it changed no prediction in the corpus.

### Two discrepancies in the original code

Found while porting, and worth knowing regardless of the app:

- **The R and Python versions select different fingerprint bits.** Both ship the
  same index list, but `EGFRpred.py` reads column `arr[3]` — where column 0 is
  the molecule name, so that is `PubchemFP2` — while `EGFRpred.R` reads `V3`, the
  third column, which is `PubchemFP1`. They are off by one from each other. This
  port follows the Python version, since that is the indexing the shipped
  scikit-learn model was trained against. On the two molecules in `test.smi`, the
  R indexing would give 0.0876 / 0.1039 instead of 0.1302 / 0.1372.
- **`imp-no` lists 50 indices but the model takes 49.** `EGFRpred.py` slices
  `x[0:49]`, silently discarding the last one, so `PubchemFP845` is dead weight.
  `tools/export_model.py` reports this and follows the original.

There is also a latent bug in the original scoring: `if sa >= "0.2"` compares the
score as a *string*. It happens to agree with a numeric comparison for every
score the model can produce, so results are unaffected; the port compares
numbers.

---

## Layout

```
app/                        the Svelte application
  src/lib/fingerprint/      the 49 PubChem bits, on RDKit
    bits.json               all 881 bit definitions (generated)
  src/lib/model/
    forest.json             the random forest (generated)
  src/routes/+page.svelte   the UI
  scripts/                  fixture recording, validation, smoke test
  tests/fixtures/           PaDEL ground truth, gzipped
  static/                   RDKit wasm, staged from node_modules on install
tools/
  export_model.py           pickle -> forest.json
  extract_pubchem_bits.py   CDK bytecode -> bits.json
EGFRpred.py, model, ...     the legacy pipeline (unchanged)
```

Both generated files are committed, so the app builds without a JDK or Python.
To regenerate them (needs Python 3 with numpy, and a JDK for `javap`):

```bash
python3 tools/export_model.py
python3 tools/extract_pubchem_bits.py
```

---

## Legacy pipeline

The original command-line tool still works, and remains the reference this port
is validated against. It needs Python 2.7, `scikit-learn==0.15.2`,
`numpy==1.10.4` and a JRE:

```bash
conda create -n egfr_py2 python=2.7 -y
conda activate egfr_py2
pip install scikit-learn==0.15.2 numpy==1.10.4
python EGFRpred.py test.smi test_out.csv
```

Running it on a modern scikit-learn raises
`TypeError: __cinit__() takes exactly 6 positional arguments`, because the Cython
tree constructor changed. `tools/export_model.py` sidesteps that entirely.

An R implementation is in `EGFRpred-standalone-R-version.zip`. Note the bit
indexing discrepancy described above before using it.

---

## Citation

> QSAR based model for discriminating EGFR inhibitors and non-inhibitors using
> Random forest.
> Harinder Singh, Sandeep Singh, Deepak Singla, Subhash M. Agarwal and
> Gajendra P. S. Raghava.
> *Biology Direct*, 2015, 10:10. [doi:10.1186/s13062-015-0046-9](https://doi.org/10.1186/s13062-015-0046-9)

For research use only. Not a clinical or regulatory decision tool.

## License

See `GNU_LICENSE` and `license/` for terms covering this project and the bundled
CDK/PaDEL components. RDKit is distributed under the BSD 3-clause license.
