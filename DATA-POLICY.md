---
title: "event-hog Data Policy"
lede: "Your team's contacts, notes and photos are stored so you can use them. Nobody behind event-hog reads them or makes money from them."
publish: true
date_created: 2026-10-28
date_modified: 2026-11-08
date_authored_initial_draft: 2026-10-28
date_authored_current_draft: 2026-10-28
date_authored_final_draft:
authors:
  - Michael P. Staton
augmented_with:
  - Claude Code on Claude Opus 5.5 (1M context)
at_semantic_version: 0.0.0.1
status: Draft
tags:
  - Policy
  - Event-Hog
  - Privacy
site_uuid: 4c64dc01-3e08-48d3-8f9b-50a7623772bd
hex_code: kdahgs
---

# event-hog Data Policy

> **Draft, 2026-10-28.** Plain-language commitments from The Lossless Group.
> Not yet reviewed by a lawyer.

## Who this covers

- **If you run event-hog on your own Cloudflare account,** your data never
  reaches us, and this policy doesn't apply: you hold it.
- **If your team uses the event-hog we run,** this is what we commit to.
  "We" means The Lossless Group and anyone who maintains or contributes to
  event-hog.

## What's stored

What your team puts in: event workspaces (prep, contacts, notes, slide
notes, drafts, flash cards), the structured contact database built from
them, slide photos and other uploaded files, your team's settings, and the
name and email of each person with a connector link. It's stored on
Cloudflare (Artifacts, D1, R2) so your team can use it.

## What we commit to

1. **We don't look at it.** We don't open, read, search or browse your
   team's workspaces, contacts, notes, photos or database records.
2. **We don't use it commercially.** We don't sell it, share it, market to
   the people in it, add it to any other product or database, or use it to
   train or tune AI models.
3. **It stays your team's.** A connector link reaches only its own team's
   data. Each team signed up on our deployment has its own database, its
   own workspaces and its own folder of files, and the code refuses any
   reach into another team's. We don't combine one team's data with
   another's.

**The only exceptions:**
- **You ask us to help** (something is broken and you want us to look).
  Then we look only at what that request needs, and only for that request.
- **The law requires it,** in which case we tell you unless we're legally
  barred from doing so.

## What this policy can't promise

- **It's a promise, not a lock.** We run the Cloudflare account, so the
  people who operate it technically *can* reach the data. This policy is
  our commitment not to. If you need a technical guarantee, run event-hog
  on your own account.
- **`/media/` links are public.** Anyone you send a photo's or page's link
  to can open it. The links can't be guessed, but don't put anything there
  you wouldn't share by link.
- **Your AI app sees what you send it.** Claude, Codex or another assistant
  processes your conversations under your own agreement with that company,
  not under this policy.
- **Your CRM is yours.** Contacts you sync to HubSpot or another CRM are
  governed by your agreement with that CRM.

## Leaving

Ask, and we'll delete your team's workspaces, files and database records
from our account. Before we do, we can hand you a copy: the workspaces are
plain git repos and the contacts are a CSV. Deleting a team erases all of
it at once and stops every connector link on the team from working. We
keep only a scrambled form of each old link (a hash, no names or emails),
so it can't be reused.

## Changes

If this policy changes, teams on our deployment hear about it before it
takes effect. The history of this file is the record.
