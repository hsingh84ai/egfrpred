import adapter from '@sveltejs/adapter-static';

/**
 * Fully static output: there is no server side to this app, so the whole
 * pipeline (fingerprint + model) ships to the browser and the build is a
 * directory of files any static host can serve.
 *
 * BASE_PATH lets the same build be served from a project subpath, which is what
 * GitHub Pages needs (https://user.github.io/egfrpred).
 */
const config = {
  kit: {
    adapter: adapter({ fallback: '404.html' }),
    paths: { base: process.env.BASE_PATH ?? '' },
  },
};

export default config;
