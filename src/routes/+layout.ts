// Everything runs in the browser: the model, the fingerprint and RDKit's wasm
// module all need a DOM/`window`, and there is no server to render against.
export const prerender = true;
export const ssr = false;
