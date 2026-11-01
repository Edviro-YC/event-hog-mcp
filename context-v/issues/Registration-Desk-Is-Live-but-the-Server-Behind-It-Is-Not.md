---
title: "The Registration Desk Is Live, but the Server Behind It Is Not"
lede: "eventhog.cc now hands out connector links for self-serve onboarding. The Worker they point at is still the old one, so every new link fails with \"Unknown connector key\"."
publish: true
date_created: 2026-10-29
date_modified: 2026-10-29
date_authored_initial_draft: 2026-10-29
date_authored_current_draft: 2026-10-29
date_authored_final_draft:
authors:
  - Michael P. Staton
augmented_with:
  - Claude Code on Claude Opus 5.5 (1M context)
at_semantic_version: 0.0.0.1
status: Open
tags:
  - Issue
  - Event-Hog
  - Deployment
  - Onboarding
site_uuid: 840eba14-f4e8-4863-b95e-9d049b822250
hex_code: kehi3z
summary: >-
  PR #1 (self-serve onboarding, merged as cad4c52) shipped two halves that
  deploy separately. The splash half deployed itself through GitHub Pages;
  the Worker half (members on first use, get_started, enrich_people, the
  fuller CRM sync) has not been deployed, and its two D1 migrations have not
  been applied. Lists what to apply and deploy, from where, and the open
  question of whether a public desk should sign strangers up on a client's
  deployment. Not started.
related:
  - "[[Pick-a-CRM-and-Go]]"
  - "[[DATA-POLICY]]"
type: Issues
---

# The Registration Desk Is Live, but the Server Behind It Is Not

> **Status: Open, not started.** Written 2026-10-29, right after pulling PR #1.

> **Update, 2026-10-29 afternoon (Tanuj):** the Worker half is deployed.
> Migration 0006 was already on `agnostic-crm`; 0007 was applied, and
> `event-hog` was deployed from `82d8e86` (PR #1's head) at 05:53 UTC, from
> a git-ignored `wrangler.event-hog.jsonc`, with `CONTEXT_DEV_API_KEY` set.
> Checked at 19:40 UTC: a brand-new key gets `initialize` and `whoami`
> (as a guest who should run `get_started`), and `enrich_people` answers.
> The "Unknown connector key" check above likely ran against a cached or
> older response; if it still fails for you, send the key's first 6
> characters. What's left is the decision below.

## What's wrong

PR #1 ("self-serve onboarding", merged as `cad4c52`) changed two things
that deploy in two different ways:

| Half | Deploys how | State on 2026-10-29 |
|---|---|---|
| **Splash** (`splash/`): the "Pick up your badge" desk on eventhog.cc, which makes a private connector link in the browser and hands it out in a copy-a-prompt | GitHub Pages, automatically on push to `main` | **Live** |
| **Worker** (`src/`): members made on first use, `get_started`, `save_attendees`, `targets`, `enrich_people`, `met_by` / `owner` on CRM sync, meetings and tasks to HubSpot, bundled kit | `npx wrangler deploy`, by hand, from the account that owns the Worker | **Not deployed** |

The desk points at `https://event-hog.tanujsiripurapu.workers.dev` (the
fallback in `splash/src/pages/index.astro` when `PUBLIC_EVENTHOG_SERVER`
isn't set). That Worker still runs the code from before the PR, which only
knows the keys in the `PEOPLE` secret. Checked 2026-10-29:

```
POST /mcp/<a new key>  →  "Unknown connector key"
```

So anyone who follows the desk today gets a connector that fails on its
first call.

## What has to happen

1. **Apply the two new migrations** to the live D1 database, before the
   deploy (the new code reads these tables):
   - `migrations/0006_members.sql`: people made on first use
   - `migrations/0007_enrichments.sql`: the `enrich_people` cache

   ```bash
   npx wrangler d1 migrations apply agnostic-crm --remote
   ```
2. **Optional secret:** `npx wrangler secret put CONTEXT_DEV_API_KEY` to
   turn on `enrich_people`. Without it, everything else works.
3. **Deploy the Worker:** `npx wrangler deploy` (the build bundles `kit/`).
4. **Check:** a new key from the desk answers `tools/list` and lists
   `get_started`; an existing `PEOPLE` key still works and still wins.

### Where to deploy from

This repo's `wrangler.jsonc` is a template full of `<placeholders>`; it
can't deploy as is. The live deployment's real values (D1 id, brain
namespace, `PUBLIC_URL`) live in Edviro's original copy at
`self-host-stack/hubs/event-hog-mcp/`, which predates this PR. Either:

- put them in a git-ignored `wrangler.<name>.jsonc` in this repo, as the
  README now suggests, and deploy with `-c wrangler.<name>.jsonc`; or
- bring PR #1's changes into the original copy and deploy from there.

The first one ends the double bookkeeping between the two copies, so it's
the better choice. Only someone with access to the Cloudflare account
that owns the Worker can do this.

## Decide first

**Should a public page sign strangers up on this deployment?** The Worker
behind the desk is Edviro's (Tanuj's Cloudflare account): its D1, its
Artifacts, its R2. With members made on first use, anyone who finds
eventhog.cc can create a member there and start writing event workspaces
into it. That conflicts with:

- [[DATA-POLICY]], which describes "the event-hog we run" (ours) and
  promises per-team isolation that isn't built yet;
- [[Pick-a-CRM-and-Go]], which notes that today one deployment serves one
  team.

Options:
1. Point the desk at a deployment on **our** account, set
   `PUBLIC_EVENTHOG_SERVER` for the splash build, and keep Edviro's
   Worker private. Needs per-team isolation before a second team joins.
2. Keep the desk on Edviro's Worker, but only for their own people:
   remove or gate it on the public page.
3. Take the desk down until one of the above is ready.

Until this is decided, the safest move is option 3 (or keep the Worker
undeployed, which is today's state: links fail and nothing gets written).

## Done when

- [ ] Someone decided which deployment the public desk points at
- [x] Migrations 0006 and 0007 applied to that deployment's D1
- [x] That Worker is deployed from `cad4c52` or later (its content: `82d8e86`)
- [x] A fresh key from eventhog.cc connects and `get_started` answers
- [ ] An existing `PEOPLE` key still works
