<script lang="ts">
  import { onMount } from 'svelte';
  import type { RDKitModule } from '@rdkit/rdkit';
  import { CanvasEditor } from 'openchemlib';
  import { loadRDKit } from '$lib/rdkit';
  import { DECISION_THRESHOLD, parseInput, predictAll, toCSV, type Prediction } from '$lib/predict';
  import { appendMolecule, molfileToSmiles, SketchError } from '$lib/sketcher';

  /** Where the original datasets live; they are linked, never redistributed. */
  const DATA_SITE = 'https://webs.iiitd.edu.in/oscadd/egfrpred';

  const SAMPLE = `COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1\tgefitinib
C#Cc1cccc(Nc2ncnc3cc(OCCOC)c(OCCOC)cc23)c1\terlotinib
CC(=O)Oc1ccccc1C(=O)O\taspirin
c1ccc(cc1CCCCCCCCCCCCCCC)O)N\tmalformed_example`;

  let rdkit = $state<RDKitModule | null>(null);
  let loadError = $state<string | null>(null);
  let input = $state('');
  let results = $state<Prediction[]>([]);
  let running = $state(false);
  let progress = $state({ done: 0, total: 0 });
  let selected = $state<Prediction | null>(null);

  let sketching = $state(false);
  let sketchHost = $state<HTMLDivElement | null>(null);
  let sketchError = $state<string | null>(null);
  let drawnCount = $state(0);
  let editor: CanvasEditor | null = null;

  const molecules = $derived(parseInput(input));
  const hits = $derived(results.filter((r) => r.label === 'Anti-EGFR').length);
  const failures = $derived(results.filter((r) => r.score === null).length);

  onMount(async () => {
    try {
      rdkit = await loadRDKit();
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  });

  async function run() {
    if (!rdkit || running || molecules.length === 0) return;
    running = true;
    results = [];
    selected = null;
    progress = { done: 0, total: molecules.length };

    // Yield once so the progress UI paints before the synchronous scoring loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      results = predictAll(rdkit, molecules, (done, total) => {
        progress = { done, total };
      });
    } finally {
      running = false;
    }
  }

  // The editor is built against a DOM node, so it is created once that node
  // exists and destroyed when the panel closes -- it holds a canvas and
  // listeners that would otherwise leak across open/close cycles.
  $effect(() => {
    const host = sketchHost;
    if (!host) return;
    editor = new CanvasEditor(host);
    return () => {
      editor?.destroy();
      editor = null;
    };
  });

  /**
   * Turn what is drawn into a line of input.
   *
   * Deliberately routed through the textarea rather than scored directly: the
   * drawn structure then goes through the same parse and predict path as typed
   * input, and stays visible and editable instead of vanishing into a result.
   */
  function addDrawing() {
    if (!rdkit || !editor) return;
    sketchError = null;
    try {
      const smiles = molfileToSmiles(rdkit, editor.getMolecule().toMolfile());
      drawnCount += 1;
      input = appendMolecule(input, smiles, `drawn-${drawnCount}`);
      editor.clearAll();
    } catch (error) {
      sketchError = error instanceof SketchError ? error.message
        : `could not read that structure: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function onFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text().then((text) => {
      input = text;
    });
  }

  function download() {
    const blob = new Blob([toCSV(results)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'egfrpred_results.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Renders the selected molecule; RDKit returns a complete inline SVG. */
  function structureSVG(smiles: string): string {
    if (!rdkit) return '';
    const mol = rdkit.get_mol(smiles);
    if (!mol) return '';
    try {
      return mol.is_valid() ? mol.get_svg(340, 240) : '';
    } finally {
      mol.delete();
    }
  }
</script>

<svelte:head><title>EGFRpred</title></svelte:head>

<main>
  <header>
    <h1>EGFRpred</h1>
    <p class="tagline">
      Random-forest prediction of EGFR inhibition from SMILES. Everything &mdash; fingerprints,
      model, rendering &mdash; runs in your browser; no molecule is uploaded anywhere.
    </p>
  </header>

  {#if loadError}
    <p class="banner error">Could not load the chemistry engine: {loadError}</p>
  {:else if !rdkit}
    <p class="banner">Loading chemistry engine&hellip;</p>
  {/if}

  <section class="panel">
    <label for="smiles">SMILES input <span class="hint">one per line, optional name after whitespace</span></label>
    <textarea
      id="smiles"
      bind:value={input}
      rows="8"
      spellcheck="false"
      placeholder={'CCO\tethanol'}
    ></textarea>

    <div class="controls">
      <button onclick={run} disabled={!rdkit || running || molecules.length === 0}>
        {running ? `Scoring ${progress.done}/${progress.total}` : `Predict ${molecules.length || ''}`}
      </button>
      <label class="file">
        Load .smi file
        <input type="file" accept=".smi,.smiles,.txt,.csv" onchange={onFile} />
      </label>
      <button class="link" onclick={() => { sketching = !sketching; sketchError = null; }}>
        {sketching ? 'Close editor' : 'Draw structure'}
      </button>
      <button class="link" onclick={() => (input = SAMPLE)}>Use example</button>
      {#if results.length}
        <button class="link" onclick={download}>Download CSV</button>
      {/if}
    </div>

    {#if sketching}
      <div class="sketcher">
        <div class="canvas" bind:this={sketchHost}></div>
        <div class="controls">
          <button onclick={addDrawing} disabled={!rdkit}>Add to input</button>
          <button class="link" onclick={() => editor?.clearAll()}>Clear</button>
          <span class="hint">the drawn structure is added as SMILES, then scored like any other line</span>
        </div>
        {#if sketchError}<p class="why">{sketchError}</p>{/if}
      </div>
    {/if}
  </section>

  {#if results.length}
    <section class="panel">
      <p class="summary">
        <strong>{hits}</strong> of <strong>{results.length}</strong> predicted anti-EGFR
        (score &ge; {DECISION_THRESHOLD.toFixed(2)}){#if failures}, <strong>{failures}</strong> could not be parsed{/if}.
      </p>

      <div class="scroll">
        <table>
          <thead>
            <tr><th>Molecule</th><th>Prediction</th><th class="num">Score</th><th></th></tr>
          </thead>
          <tbody>
            {#each results as result (result.id + result.smiles)}
              <tr class:failed={result.score === null}>
                <td><code>{result.id}</code></td>
                <td>
                  <span class="tag {result.score === null ? 'err' : result.label === 'Anti-EGFR' ? 'yes' : 'no'}">
                    {result.label}
                  </span>
                  {#if result.error}<span class="why">{result.error}</span>{/if}
                </td>
                <td class="num">
                  {#if result.score !== null}
                    <span class="bar" style="--w: {Math.min(result.score / 0.6, 1) * 100}%"></span>
                    {result.score.toFixed(4)}
                  {:else}&mdash;{/if}
                </td>
                <td>
                  {#if result.score !== null}
                    <button class="link" onclick={() => (selected = selected === result ? null : result)}>
                      {selected === result ? 'hide' : 'view'}
                    </button>
                  {/if}
                </td>
              </tr>
              {#if selected === result}
                <tr class="structure">
                  <td colspan="4">
                    <div class="depiction">
                      {@html structureSVG(result.smiles)}
                      <code class="smiles">{result.smiles}</code>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <section class="panel">
    <h2>Data</h2>
    <p class="data">
      The datasets are not redistributed here; these link to the
      <a href="{DATA_SITE}/download.php" target="_blank" rel="noopener noreferrer">original EGFRpred site</a>.
    </p>
    <ul class="data">
      <li>
        The EGFRindb ids of Benchmark dataset can be downloaded from:
        <a href="{DATA_SITE}/Dataset.xlsx" target="_blank" rel="noopener noreferrer">data here</a>
      </li>
      {#each [10, 100, 1000] as size (size)}
        <li>
          EGFR{size} dataset in smiles format:
          <a href="{DATA_SITE}/active-{size}.smi" target="_blank" rel="noopener noreferrer">Active dataset</a>
          |
          <a href="{DATA_SITE}/inactive-{size}.smi" target="_blank" rel="noopener noreferrer">Inactive dataset</a>
        </li>
      {/each}
    </ul>
  </section>

  <footer>
    <p>
      Model and fingerprint reproduce the original EGFRpred pipeline (PaDEL-Descriptor +
      scikit-learn random forest). Method:
      <a href="https://doi.org/10.1186/s13062-015-0046-9">Singh et al., <em>Biology Direct</em> 2015;10:10</a>.
    </p>
    <p class="caveat">For research use only. Not a clinical or regulatory decision tool.</p>
  </footer>
</main>

<style>
  :global(html) {
    color-scheme: light dark;
    --bg: #fbfbfd;
    --fg: #16181d;
    --muted: #676d7a;
    --line: #e2e5ea;
    --card: #fff;
    --accent: #2f6f4f;
    --accent-soft: #e6f2ea;
    --warn: #8a4b12;
    --warn-soft: #fbeee0;
  }
  @media (prefers-color-scheme: dark) {
    :global(html) {
      --bg: #14161a;
      --fg: #e8eaee;
      --muted: #9aa1ae;
      --line: #2a2e36;
      --card: #1b1e24;
      --accent: #7fc9a1;
      --accent-soft: #1e2f26;
      --warn: #e0a86a;
      --warn-soft: #2f2519;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }

  main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1rem; margin: 0 0 .45rem; }
  .data { margin: 0; font-size: .9rem; color: var(--muted); }
  .data a { color: inherit; overflow-wrap: anywhere; }
  ul.data { margin: .6rem 0 0; padding-left: 1.1rem; }
  ul.data li { margin-bottom: .3rem; }
  .tagline { color: var(--muted); margin: 0 0 1.75rem; max-width: 46rem; }

  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: .7rem;
    padding: 1.15rem;
    margin-bottom: 1.25rem;
  }
  label { display: block; font-weight: 600; margin-bottom: .45rem; }
  .hint { font-weight: 400; color: var(--muted); font-size: .85em; }

  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: .7rem;
    border: 1px solid var(--line);
    border-radius: .45rem;
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
  }

  .controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: .8rem; }
  button {
    font: inherit;
    font-weight: 600;
    padding: .5rem 1.05rem;
    border: 0;
    border-radius: .45rem;
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  button.link {
    background: none;
    color: var(--accent);
    padding: .5rem .3rem;
    font-weight: 500;
    text-decoration: underline;
  }
  .file { font-weight: 500; color: var(--accent); cursor: pointer; text-decoration: underline; margin: 0; }
  .file input { display: none; }

  .banner { padding: .7rem 1rem; border-radius: .45rem; background: var(--accent-soft); margin: 0 0 1.25rem; }
  .banner.error { background: var(--warn-soft); color: var(--warn); }
  .summary { margin: 0 0 .9rem; color: var(--muted); }
  .summary strong { color: var(--fg); }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .93rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  tr.failed { color: var(--muted); }

  .tag { display: inline-block; padding: .13rem .5rem; border-radius: 1rem; font-size: .82rem; font-weight: 600; }
  .tag.yes { background: var(--accent-soft); color: var(--accent); }
  .tag.no { background: var(--line); color: var(--muted); }
  .tag.err { background: var(--warn-soft); color: var(--warn); }
  .why { display: block; font-size: .78rem; color: var(--muted); }

  /* Score bar sits behind the number so the column stays scannable. */
  .bar {
    display: inline-block;
    height: .55rem;
    width: var(--w);
    max-width: 5rem;
    background: var(--accent);
    opacity: .35;
    border-radius: 1rem;
    margin-right: .4rem;
    vertical-align: baseline;
  }

  tr.structure td { background: var(--bg); }
  .sketcher { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  /* The editor draws its own toolbar into a canvas it sizes to this box, so it
     needs a definite height rather than one derived from its contents. */
  .sketcher .canvas {
    height: 420px; min-width: 0; background: #fff;
    border: 1px solid var(--line); border-radius: .4rem; overflow: hidden;
  }
  .sketcher .controls { margin-top: .7rem; }

  .depiction { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; padding: .5rem 0; }
  .depiction :global(svg) { background: #fff; border-radius: .4rem; border: 1px solid var(--line); }
  .smiles { color: var(--muted); word-break: break-all; }

  footer { color: var(--muted); font-size: .87rem; margin-top: 2rem; }
  footer a { color: inherit; }
  .caveat { font-style: italic; }
</style>
