// @ts-check
import { defineConfig } from 'astro/config';
import pagefind from 'astro-pagefind';
import sitemap from '@astrojs/sitemap';

// Splash for event-hog-mcp.
// Hosted on GitHub Pages from lossless-group/event-hog-mcp, at the custom
// domain eventhog.cc (DNS on Cloudflare, DNS-only records pointing at GitHub).
// The old lossless-group.github.io/event-hog-mcp/ address redirects here.
export default defineConfig({
  site: 'https://eventhog.cc',
  base: '/',
  trailingSlash: 'ignore',

  integrations: [
    // Runs Pagefind against dist/ after `astro build`; search is static and
    // client-side. See astro-knots/context-v/explorations/Implementing-Full-Text-Search-by-Default.md.
    pagefind(),
    sitemap({
      filter: (page) => !page.endsWith('/404/') && !page.endsWith('/404'),
    }),
  ],

  build: {
    // Pagefind needs a stable per-page URL.
    format: 'directory',
  },
});
