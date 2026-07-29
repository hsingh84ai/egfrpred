/**
 * Loads the RDKit WebAssembly module once per page.
 *
 * RDKit ships as an Emscripten bundle that registers `initRDKitModule` on
 * `window`, so it is loaded from /static via a script tag rather than imported;
 * bundling it would break its own runtime asset lookup for the .wasm file.
 */

import { base } from '$app/paths';
import type { RDKitModule } from '@rdkit/rdkit';

// The package declares `window.initRDKitModule` itself, but types locateFile as
// taking no arguments; Emscripten does pass the file name, which is how the
// .wasm gets resolved relative to the deployment base path.
type LocateFile = (file: string) => string;

let pending: Promise<RDKitModule> | null = null;

export function loadRDKit(): Promise<RDKitModule> {
  if (pending) return pending;

  pending = new Promise<RDKitModule>((resolve, reject) => {
    const start = () => {
      if (typeof window.initRDKitModule !== 'function') {
        reject(new Error('RDKit failed to register itself'));
        return;
      }
      const locateFile = ((file: string) => `${base}/${file}`) as LocateFile;
      window
        .initRDKitModule({ locateFile: locateFile as unknown as () => string })
        .then(resolve, reject);
    };

    if (typeof window.initRDKitModule === 'function') {
      start();
      return;
    }
    const script = document.createElement('script');
    script.src = `${base}/RDKit_minimal.js`;
    script.onload = start;
    script.onerror = () => reject(new Error('could not load RDKit_minimal.js'));
    document.head.appendChild(script);
  });

  // Let a failed load be retried rather than caching the rejection forever.
  pending.catch(() => { pending = null; });
  return pending;
}
