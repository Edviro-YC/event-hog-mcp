# event-hog splash

The GitHub Pages site for event-hog-mcp:
**https://eventhog.cc**

It's laid out like a conference: a lanyard badge in the hero, what event-hog
does as the program, the two ways to run it as passes (ours or your own
Cloudflare), a registration desk where you copy a prompt to get connected,
and the workspace as a floor plan. Light mode is the show floor, dark is after hours, vibrant is
the keynote.

## Local dev

```bash
cd splash
pnpm install --ignore-workspace
pnpm dev            # http://localhost:4321/
pnpm build && pnpm preview   # to try search; the index is built at build time
```

## Domain

`eventhog.cc`, registered on Cloudflare. DNS has four A records for `@`
(185.199.108.153 through .111.153, GitHub Pages) and a CNAME for `www` to
`lossless-group.github.io`, all **DNS only** (grey cloud): GitHub has to
see the domain directly to issue its HTTPS certificate. The custom domain
is set in the repo's Pages settings.

## Deploy

Push to `main`. `.github/workflows/pages.yml` builds `splash/` and deploys it
with GitHub Pages (source: GitHub Actions). It runs only when `splash/`,
`changelog/` or `context-v/` changes.

## Where the content lives

| What | Where |
|---|---|
| The program (what event-hog does) | `src/content/program/*.md`, one file per session. `status: partial` with a `status_note` shows an "In progress" stamp |
| Hero, lost & found, passes, floor plan, fine print | `src/pages/index.astro` (arrays at the top) |
| The registration desk's prompt and server | `src/pages/index.astro` (`PROMPT`, `SERVER`). `SERVER` is the Worker people connect to; set `PUBLIC_EVENTHOG_SERVER` at build time to point it elsewhere. The connector key is made in the visitor's browser |
| Changelog pages | `../changelog/*.md` |
| Context pages | `../context-v/**/*.md`. Files with `publish: false` are skipped |
| Titles and descriptions | `src/lib/seo.ts` |
| Share images | `public/ogimage__Event-Hog--{Banner,BannerTall,BannerTallMax,Portrait,PortraitTall,Square}.jpg`, rendered from `og-source/og.html?f=<format>` at each format's exact size. Older versions go in `.ogimage-archive/` |
| Icons | `public/favicon.svg` (the pig) is the source. Rasterized from it: `favicon.ico` (16, 32, 48), `favicon-96x96.png`, `apple-touch-icon.png` (180), and `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` for `site.webmanifest`. Redraw the SVG, then re-render all of them |

Keep the fine print in step with the README's "What the server guarantees"
section. If one changes, change the other.

## Adding a changelog entry

One file per thing that shipped, in `../changelog/`, named
`YYYY-MM-DD_NN.md` (`NN` counts up within the day). Copy the front matter of
the newest entry and change: `site_uuid` (`uuidgen | tr A-Z a-z`), `hex_code`
(any six lowercase letters and digits), the four dates, `title` (what a
reader can now do, as a sentence), `lede`, `summary`, `category` (`Release`,
`Feature`, `Fix`...), `tags`, `authors`, `augmented_with` and
`at_semantic_version`. The body has `## Why Care?` and `## What's New?`.
`publish: false` keeps a draft off the site. Merge to `main` and the Pages
workflow puts it on [eventhog.cc/changelog](https://eventhog.cc/changelog/).

## Analytics

OpenPanel, production builds only (`src/components/Analytics.astro`). It
reads the repo Variable `OPENPANEL_CLIENT_ID`; without it, no script ships.
The OpenPanel client must list `https://eventhog.cc` as a supported domain,
or every event is rejected with a 401.

## Isolation from the server

The splash is separate from the Worker: the root `tsconfig.json` only
includes `src/`, `wrangler.jsonc` bundles only `src/index.ts`, and
`splash/package.json` is `private`.

## Type

Big Shoulders Display (signage), Atkinson Hyperlegible Next (body), Martian
Mono (badge numbers and tool names), from Google Fonts.
