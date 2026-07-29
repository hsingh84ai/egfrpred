# EGFRpred

Predicts whether a molecule is an EGFR inhibitor from its SMILES string, using a
random forest over PubChem substructure fingerprints.

It runs entirely in the browser. There is no Python, no Java, no server and no
upload: the fingerprint, the model and the structure rendering all execute
client-side, so molecules never leave the machine they are typed on.

This is a port of the original 2015 command-line tool, which needed Python 2.7,
scikit-learn 0.15.2 and a JRE. It reproduces that pipeline's output — see
[Fidelity](#fidelity).

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Requires Node 20.19+ or 22.12+. `npm install` also stages RDKit's 7 MB
WebAssembly build into `static/`, so it takes a moment.

To produce a deployable static site:

```bash
npm run build        # -> build/, about 7 MB
```

`build/` is plain files. Any static host works — GitHub Pages, Netlify, S3, or
`npx serve build`. To serve from a subpath, as GitHub Pages project sites do:

```bash
BASE_PATH=/egfrpred npm run build
```

Paste SMILES one per line, optionally followed by whitespace and a name, or load
a `.smi` file. Results download as CSV in the format the original tool emitted:

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
| Feature selection | index file read at runtime | baked into the exported model |
| Random forest | `cPickle` + scikit-learn 0.15.2 | 254 KB of JSON, ~50 KB gzipped |

Two things made this practical.

**The model is just arrays.** The original `model` pickle can only be read by
scikit-learn 0.15.2 on Python 2.7 — newer versions raise
`TypeError: __cinit__() takes exactly 6 positional arguments`, because the Cython
tree constructor changed. But that is a serialization problem, not a modelling
one. Substituting stub classes for every `sklearn.*` symbol lets a modern Python
read the pickle with scikit-learn not installed at all. What comes out is 100
trees of plain arrays — and because all 49 inputs are binary fingerprint bits,
**every split threshold is 0.5**, so inference reduces to bit tests and an
average.

**Only 49 of the 881 bits are needed.** The bit definitions in
`src/lib/fingerprint/bits.json` were not transcribed by hand from the PubChem
specification; they were scraped out of CDK's `PubchemFingerprinter` bytecode, so
the app tests the same predicates the model was trained on. Of the 49 selected:
2 are element counts, 8 are SSSR ring predicates, and 39 are SMARTS presence
tests.

---

## Fidelity

Checked against the real `PaDEL-Descriptor.jar` over a 3852-molecule corpus built
to stress the ring and element-count bits — steroids, cages, fused arenes,
porphyrins, polyamines, and the marketed EGFR inhibitors:

```
48/49 bits match PaDEL exactly
label disagreements: 0/3852 (0.00%)
largest score difference: 0.0111
```

```bash
npm test             # against the recorded fixture; no JDK needed
npm run smoke        # drive the built site in a real browser
npm run analyse      # re-derive the CDK quirk described below
```

Reaching that required reproducing three behaviours of the original stack that
are arguably bugs. Since the model was *trained* on data that stack produced,
matching it means matching those too.

**1. Hydrogens are never counted.** CDK counts hydrogen *atoms*, and PaDEL only
converts implicit hydrogens into atoms under its `-addhydrogens` flag, which the
original command line never passed. So bit 2 (">= 16 hydrogens") is never set —
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
bug (`isUnmatchableInCDK`). `npm run analyse` re-derives this from the fixture.

**3. Ring counting and aromatic bonds differ from RDKit.** RDKit returns a
*symmetrised* SSSR — adamantane comes back with four six-rings where CDK returns
three, directly visible in bit 199 ("four or more six-membered rings"). The app
reduces RDKit's ring set to a true minimum cycle basis. Separately, RDKit reads
SMARTS `:` as "this bond is aromatic" while CDK reads it as "both atoms are
aromatic" — CDK also matches the plain single bond joining two rings, which is
why PaDEL sets bit 386 on 2,2'-bipyridine. The app rewrites those patterns.

### Known deviation

One bit still differs: **bit 386** (`[#6](:c)(:c)(:n)`) on fused rings bearing an
exocyclic carbonyl — guanine, caffeine and folate in the corpus, 3 of 3852
molecules. RDKit's aromaticity model calls those rings aromatic; CDK's Hückel
detector does not. Closing it would mean porting CDK's aromaticity perception.
The measured cost is a score shift of at most 0.0111, against a decision
threshold of 0.20, and it changed no prediction in the corpus.

### Model limitations

These are the 2015 model's, not the port's, and are reproduced faithfully:

- **Erlotinib scores 0.1880** and is called a non-inhibitor, just under the 0.20
  threshold, despite being a marketed EGFR inhibitor.
- **Featureless molecules land on a baseline.** Hexadecane scores 0.1604, the
  same as aspirin, because a plain alkane trips almost none of the 49 bits.

The original also compared its score as a *string* (`if sa >= "0.2"`). That
happens to agree with a numeric test for every score the model can produce, so
results are unaffected; this port compares numbers.

---

## Layout

```
src/lib/fingerprint/    the 49 PubChem bits, on RDKit
  bits.json             all 881 bit definitions (generated)
src/lib/model/
  forest.json           the random forest (generated)
src/routes/+page.svelte the UI
scripts/                fixture recording, validation, smoke test
tests/fixtures/         PaDEL ground truth, gzipped
static/                 RDKit wasm, staged from node_modules on install
```

Both generated files are committed, so the app builds and runs with no Java or
Python anywhere in the loop.

### Regenerating from the original artifacts

The legacy distribution — `model`, `PaDEL-Descriptor.jar`, `lib/`,
`descriptors.xml`, `imp-no` — is not vendored here. It remains in this
repository's history, and the two Python tools that consumed it
(`tools/export_model.py`, `tools/extract_pubchem_bits.py`) can be recovered
from there:

```bash
git log --oneline --all -- tools
git checkout <commit> -- tools model imp-no PaDEL-Descriptor.jar descriptors.xml lib
```

To re-record the PaDEL ground truth, point `PADEL_HOME` at a legacy checkout:

```bash
PADEL_HOME=/path/to/egfrpred-legacy npm run fixture
```

Nothing in the normal build, test or run path needs any of this.

---

## Citation

> QSAR based model for discriminating EGFR inhibitors and non-inhibitors using
> Random forest.
> Harinder Singh, Sandeep Singh, Deepak Singla, Subhash M. Agarwal and
> Gajendra P. S. Raghava.
> *Biology Direct*, 2015, 10:10. [doi:10.1186/s13062-015-0046-9](https://doi.org/10.1186/s13062-015-0046-9)

For research use only. Not a clinical or regulatory decision tool.

## License

See `GNU_LICENSE`. The bundled model weights derive from the original EGFRpred
release and remain under its terms. RDKit is distributed under the BSD 3-clause
license.
