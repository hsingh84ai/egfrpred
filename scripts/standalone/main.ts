/**
 * Entry point for the standalone single-file build.
 *
 * SvelteKit's own client is a router: it resolves a route from location.pathname
 * and fetches its node chunks. Neither makes sense in a file opened from disk,
 * and both fight the inliner. The app is one route with `ssr = false` and no
 * links, so mounting the page component directly is equivalent -- and drops the
 * router from the output.
 */

import { mount } from 'svelte';
import Page from '../../src/routes/+page.svelte';

mount(Page, { target: document.getElementById('app')! });
