/**
 * Static SEO copy for the event-hog splash. Centralized so MetaTags, the
 * index hero and the share image all read from one source of truth.
 */

/**
 * Share images: the hero badge, rendered per format from og-source/og.html
 * (Playwright screenshot at each format's exact size), saved as JPEG (several
 * unfurlers still drop WebP). Named per the generate-consistent-og-images
 * convention. Tall formats keep the top third to the lanyard only, since
 * WhatsApp and iMessage crop tall previews from the top.
 */
const ALT = 'A conference badge on a blue lanyard: "Hello, we are event-hog. Your team\'s memory at the show." Work the room. Keep everything.';
const og = (format: string, width: number, height: number) => ({
  url: `ogimage__Event-Hog--${format}.jpg`,
  width,
  height,
  type: 'image/jpeg',
  alt: ALT,
});

export const OG_IMAGES = {
  banner: og('Banner', 1200, 630),
  bannerTall: og('BannerTall', 1200, 1600),
  bannerTallMax: og('BannerTallMax', 1200, 1800),
  portrait: og('Portrait', 1080, 1350),
  portraitTall: og('PortraitTall', 1080, 1920),
  square: og('Square', 1200, 1200),
} as const;

export const DEFAULT_OG = OG_IMAGES.banner;

export const REPO_URL = 'https://github.com/lossless-group/event-hog-mcp';

export const STATIC_SEO = {
  brand: 'event-hog',
  titleSuffix: ' · event-hog',
  siteName: 'event-hog',

  root: {
    title: 'event-hog: work the room, keep everything',
    description:
      "A shared workspace for a team working a conference, inside Claude or Codex. Prep before, contacts, notes and slides during, follow-ups after. Plain markdown files first; Cloudflare and your CRM when you want them. Open source.",
  },

  changelog: {
    title: 'Changelog',
    description: 'What shipped in event-hog, when, and why.',
  },

  contextV: {
    title: 'Context',
    description:
      'The decisions, specs and plans behind event-hog, written down so anyone can check our reasoning.',
  },
} as const;
