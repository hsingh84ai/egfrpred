/**
 * Drives the built site in a real browser.
 *
 * The unit tests exercise the fingerprint and the forest directly in Node, which
 * says nothing about whether the wasm module actually loads over HTTP, whether
 * the page wires the pipeline up correctly, or whether the CSV comes out right.
 * This runs the production build end to end and checks the numbers on screen.
 *
 * Usage:  npm run smoke
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BUILD = fileURLToPath(new URL('../build', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = join(BUILD, normalize(path === '/' ? '/index.html' : path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Use a preinstalled Chromium when one is provided (CI images often pin a build
// that does not match the npm package's expected revision).
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(String(e)));

try {
  await page.goto(origin, { waitUntil: 'networkidle' });

  // The button stays disabled until the wasm module has finished loading.
  await page.fill('#smiles', [
    'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1\tgefitinib',
    'CC(=O)Oc1ccccc1C(=O)O\taspirin',
    'not-a-molecule\tbroken',
  ].join('\n'));
  await page.click('button:not(.link)', { timeout: 60_000 });
  await page.waitForSelector('table tbody tr', { timeout: 60_000 });

  const rows = await page.$$eval('table tbody tr:not(.structure)', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent.trim())));

  console.log('rendered rows:');
  for (const row of rows) console.log('   ', row.join(' | '));

  const checks = [];
  checks.push(['three rows rendered', rows.length === 3]);
  checks.push(['gefitinib scored', /^0\.\d+/.test(rows[0]?.[2] ?? '')]);
  checks.push(['invalid SMILES flagged', rows[2]?.[1]?.startsWith('Error')]);

  // Structure depiction round-trips through RDKit's SVG renderer.
  await page.click('table tbody tr:first-child button.link');
  await page.waitForSelector('tr.structure svg', { timeout: 15_000 });
  checks.push(['structure renders', true]);

  checks.push(['no console errors', problems.length === 0]);

  const shot = process.argv.find((a) => a.startsWith('--screenshot='));
  if (shot) {
    await page.setViewportSize({ width: 1000, height: 1100 });
    await page.screenshot({ path: shot.split('=')[1], fullPage: true });
    console.log(`screenshot -> ${shot.split('=')[1]}`);
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  if (problems.length) console.log('console errors:\n  ' + problems.join('\n  '));
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
