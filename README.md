# EGFRpred

Predict whether a molecule inhibits EGFR from its SMILES string, in the browser.

Paste SMILES, get a call and a score. The fingerprint, the random forest and the
structure drawing all run client-side — there is no server, no upload and no
network traffic at runtime, so molecules never leave the machine they are typed
on. The whole thing is a SvelteKit app that builds to static files.

## Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:5173. `npm install` also stages RDKit's 7 MB
WebAssembly build into `static/`, so it takes a moment. Node 20.19+ or 22.12+;
also tested on Node 26.

Input is one SMILES per line, optionally followed by whitespace and a name, or a
`.smi` file. Results download as CSV in the format the original tool emitted:

```
#Molecule_ID,Prediction,Prediction_score
gefitinib,Anti-EGFR,0.5565
aspirin,Non-anti-EGFR,0.1604
```

## Building

```bash
npm run build          # -> build/, a static site, about 7 MB
npm run build:single   # -> build/egfrpred-standalone.html, one 9 MB file
```

`build/` is plain files; any static host works — GitHub Pages, Netlify, S3, or
`npx serve build`. To serve from a subpath, as GitHub Pages project sites do:

```bash
BASE_PATH=/egfrpred npm run build
```

`build:single` produces **one HTML file with everything embedded**: the app, the
model, and RDKit's WebAssembly binary base64-encoded inside it. Open it by
double-clicking — no server, no install, works offline and from a USB stick. It
is built separately (`scripts/standalone/`), mounting the same page component
with plain Vite, because SvelteKit's client is a router that resolves routes from
`location.pathname` and loads chunks on demand; neither survives being flattened
into a file opened from disk.

## Scripts

| | |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | static site |
| `npm run build:single` | single-file build |
| `npm test` | fingerprint against recorded PaDEL output — the regression gate |
| `npm run smoke` | drive the built site in a real browser |
| `npm run smoke -- --single` | drive the standalone file, and assert it makes no network requests |
| `npm run analyse` | re-derive the CDK quirk described below |
| `npm run check` | svelte-check |

## How it works

```
SMILES -> RDKit (wasm) -> 49 PubChem fingerprint bits -> random forest -> score
```

A score at or above **0.20** is called `Anti-EGFR`.

- **The fingerprint** is 49 of the 881 PubChem substructure bits — the ones the
  model actually uses. Of those, 2 are element counts, 8 are SSSR ring predicates
  and 39 are SMARTS presence tests. The definitions in
  `src/lib/fingerprint/bits.json` were scraped out of CDK's `PubchemFingerprinter`
  bytecode rather than transcribed from the PubChem specification, so the app
  tests the same predicates the model was trained on.
- **The model** is 100 trees in `src/lib/model/forest.json`, 254 KB of JSON
  (~50 KB gzipped). Because all 49 inputs are binary, every split threshold is
  0.5, so inference is bit tests and an average.

Both generated files are committed, so the app builds and runs with no Java or
Python anywhere in the loop.

## Fidelity

The model was trained in 2015 on descriptors from `PaDEL-Descriptor.jar`, so the
target is not "a correct PubChem fingerprint" but "the fingerprint PaDEL
produces". Checked against the real jar over a 3852-molecule corpus built to
stress the ring and element-count bits — steroids, cages, fused arenes,
porphyrins, polyamines and the marketed EGFR inhibitors:

```
48/49 bits match PaDEL exactly
label disagreements: 0/3852 (0.00%)
largest score difference: 0.0111
```

`npm test` re-runs this against the recorded fixture; no JDK needed.

### Three deliberate bug-compatibilities

These look wrong. They are load-bearing. **Do not "fix" them** — `npm test` is
the gate, and each one is there because removing it breaks agreement with PaDEL.

1. **Hydrogens are never counted.** CDK counts hydrogen *atoms*, and PaDEL only
   turns implicit hydrogens into atoms under `-addhydrogens`, which the original
   command line never passed. So bit 2 (">= 16 hydrogens") is never set — not
   even for hexadecane. The app does not add them back.

2. **Five SMARTS bits are hard-coded to zero** (`isUnmatchableInCDK`). A negated
   hydrogen-count primitive (`!H0`) matches on a pattern's first atom but never
   on a later one in CDK 1.4.6. Measured across all 618 SMARTS bits over the
   corpus: all 35 patterns carrying `!H<n>` on a non-root atom are never set,
   with no counterexamples. Five of the model's inputs are in that dead set —
   513, 522, 528, 540 and 571. RDKit matches all five happily, and bit 540 alone
   would fire on 70% of molecules, so evaluating them honestly would feed the
   model bits it was never trained to see. `npm run analyse` re-derives this.

3. **Ring and aromatic-bond conventions are translated.** RDKit returns a
   *symmetrised* SSSR — adamantane comes back with four six-rings where CDK
   returns three, visible in bit 199 ("four or more six-membered rings") — so
   `reduceToSSSR()` trims it to a true minimum cycle basis. Separately RDKit
   reads SMARTS `:` as "this bond is aromatic" while CDK reads it as "both atoms
   are aromatic", which is why PaDEL sets bit 386 on 2,2'-bipyridine;
   `translateSmarts()` rewrites those patterns.

### Known deviation

One bit still differs: **bit 386** (`[#6](:c)(:c)(:n)`) on fused rings bearing an
exocyclic carbonyl — guanine, caffeine and folate, 3 of 3852 molecules. RDKit's
aromaticity model calls those rings aromatic; CDK's Hückel detector does not.
Closing it would mean porting CDK's aromaticity perception. The measured cost is
a score shift of at most 0.0111 against a threshold of 0.20, and it changed no
prediction in the corpus.

### Model limitations

These are the 2015 model's, not the app's, and are reproduced faithfully:

- **Erlotinib scores 0.1880** and is called a non-inhibitor, just under the
  threshold, despite being a marketed EGFR inhibitor.
- **Featureless molecules land on a baseline.** Hexadecane scores 0.1604, the
  same as aspirin, because a plain alkane trips almost none of the 49 bits.

The original compared its score as a *string* (`if sa >= "0.2"`). That agrees
with a numeric test for every score the model can produce, so results are
unaffected; this app compares numbers.

## Layout

```
src/routes/+page.svelte    the UI
src/lib/predict.ts         input parsing, batch prediction, CSV
src/lib/rdkit.ts           loads the wasm module once
src/lib/fingerprint/       the 49 PubChem bits, on RDKit
  bits.json                all 881 bit definitions (generated)
src/lib/model/
  forest.json              the random forest (generated)
scripts/standalone/        separate entry for the single-file build
scripts/                   fixture recording, validation, smoke test
tests/fixtures/            PaDEL ground truth, gzipped
static/                    RDKit wasm, staged from node_modules on install
```

## Provenance

This replaces a 2015 command-line tool that needed Python 2.7, scikit-learn
0.15.2 and a JRE: `.smi -> PaDEL-Descriptor.jar -> 881 bits -> keep 49 -> sklearn
RF -> score`. The model pickle it shipped can only be read by that exact
scikit-learn on Python 2.7; substituting stub classes for the `sklearn.*` symbols
lets a modern Python read it with scikit-learn not installed at all, and what
comes out is plain arrays.

That distribution — `model`, `PaDEL-Descriptor.jar`, `lib/`, `descriptors.xml`,
`imp-no` — is not vendored here. It remains in this repository's history, along
with the two Python tools that consumed it:

```bash
git log --oneline --all -- tools
git checkout <commit> -- tools model imp-no PaDEL-Descriptor.jar descriptors.xml lib
```

To re-record the PaDEL ground truth, point `PADEL_HOME` at a legacy checkout:

```bash
PADEL_HOME=/path/to/egfrpred-legacy npm run fixture
```

Nothing in the normal build, test or run path needs any of this.

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
