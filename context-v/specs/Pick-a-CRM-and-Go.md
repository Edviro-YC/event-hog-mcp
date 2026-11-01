---
title: "Pick a CRM and Go"
lede: "Choose where contacts end up (HubSpot, Twenty, or plain CSV files) once. event-hog handles the rest, with no second connector to juggle."
publish: true
date_created: 2026-10-28
date_modified: 2026-10-28
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
  - Spec
  - Event-Hog
  - CRM-Sync
  - HubSpot
  - Twenty
site_uuid: 2e0188ba-2fdc-4a2e-aa36-7a14e81de578
hex_code: ksp2df
summary: >-
  Spec for how event-hog sends logged contacts to a team's CRM. The team picks the
  destination in its own settings, with a per-event override: csv (default, nothing to connect),
  hubspot (through hubspot-mcp-wrap, Worker to Worker), or twenty (later).
  The server, not the model, enforces preview-then-approve and records the
  ID the CRM actually returned. Read before touching crm_queue,
  mark_crm_synced, export_hubspot_csv, or hubspot-mcp-wrap.
related:
  - "[[2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog]]"
type: Specs
---

# Pick a CRM and Go

## Why care?

At the first event, the team logged 21 people. None reached HubSpot. The
plan was for Claude to carry each contact from event-hog to a second
connector (the HubSpot wrapper) and back, and that never happened: it needed
both connectors in the same chat, a working HubSpot sign-in, and Claude
remembering every step.

The experience we want instead: **a team picks where contacts end up, once,
and then just logs people.** At the end of a day someone says "send today's
contacts to the CRM", sees the list, says yes, and gets links back.

It has to work for teams that aren't us, so the CRM is a choice, and "no
CRM" is a real option, not an error.

## Where data lives: always Cloudflare Artifacts

event-hog is built on Cloudflare Artifacts (plus D1 and R2) and stays that
way: no storage abstraction. A team runs it one of two ways:

| | Your own Cloudflare account | Ours (fine for now) |
|---|---|---|
| Setup | Fork, fill in `wrangler.jsonc`, deploy | We add your team and send each person their connector link |
| Your data | Never touches us | Stored in our account, under [[DATA-POLICY]]: not looked at, not used commercially |
| Isolation | The account is the boundary | Each team gets its own Artifacts namespace (its own kit and event repos), media prefix and database. A connector key only ever reaches its own team |

**Today one deployment serves one team.** Hosting several teams on ours
needs the isolation in the right-hand column built first: a team per
connector key, and every repo, file and query scoped to it.

## The one setting, owned by the team

The CRM choice belongs to the team, not to whoever runs the server, and an
event can differ from the team's usual choice (a partner's event that
feeds their CRM, say). So it lives in the team's own files:

- **Team default:** `crm` in the team kit's `config/skills.json`, next to
  their other settings.
- **Per event:** `crm` in the event workspace's `prep/event.md`
  frontmatter, written by `new_event` (it asks) and editable later. It wins
  over the team default.
- **Neither set:** `csv`.

Connection details that aren't secrets (which HubSpot portal) sit beside the
choice. Secrets never go in these files: HubSpot sign-ins stay inside
hubspot-mcp-wrap, per person.

| `crm` | What happens | Needs |
|---|---|---|
| `csv` (default) | Contacts stay in the workspace. `Contacts__Met.csv` is always current, and an import file for any CRM can be written on request | Nothing |
| `hubspot` | Contacts are created in HubSpot, owned by the person who met them | hubspot-mcp-wrap deployed in the same Cloudflare account; each person signs in to HubSpot once |
| `twenty` | Same, in Twenty | Later. Our Twenty MCP wrappers already exist for three workspaces |

Logging never depends on the CRM. `log_contact` always writes the contact
file and the database first, as it does today. The CRM is where contacts
*go next*.

## How a sync works

1. Someone asks to send contacts to the CRM. Claude calls **`crm_sync`**.
2. The first call writes nothing. It returns the list: each pending contact,
   whether a matching record already exists in the CRM (by email, then name
   and company), and what would be created or updated. Plus a one-time
   approval code.
3. The person reads it and says yes, or removes some.
4. Claude calls `crm_sync` again with the approval code. Only now does
   anything reach the CRM. An approval code is good for that exact list
   only, so a model can't skip the preview or approve something different.
5. For each contact the server records the ID the CRM returned, links it in
   the contact file, and marks it synced. It reports links to each record.

With `csv`, step 4 writes an import file under `exports/` instead, with the
right column names for the CRM the team names (HubSpot's today).

## HubSpot: how the two servers connect

- event-hog calls hubspot-mcp-wrap directly, through a Cloudflare **service
  binding**: a private connection between two Workers in one account, with
  no public URL and no shared password.
- The wrapper already keeps each person's HubSpot sign-in (encrypted). It
  gets one small internal endpoint, reachable only through the binding:
  "as this person, find or create these contacts".
- The two servers know a person by the same address: the email HubSpot
  knows them by (`crm_email` in event-hog's `PEOPLE`).
- If that person hasn't signed in to HubSpot through the wrapper yet,
  `crm_sync` says so and gives them the sign-in link. Their contacts wait.
  Nobody else's sync is blocked.
- Records are created as the person, so HubSpot shows them as the owner
  and creator, with their own permissions.

hubspot-mcp-wrap keeps its current job too: anyone can still add it to
Claude or Codex as a connector to work in HubSpot directly.

## What changes in the code

- **event-hog:** a small CRM adapter with three operations (find, create or
  update, return IDs), one implementation per destination. `crm_sync`
  replaces the model-driven `crm_queue` → create → `mark_crm_synced` loop.
  `hubspot_status` becomes `crm_status`, reading the old name too.
  `export_hubspot_csv` becomes the `csv` adapter.
- **hubspot-mcp-wrap:** the internal endpoint, plus a way to look up a grant
  by the person's HubSpot email.
- **Both:** a service binding in `wrangler.jsonc`, optional, so either
  server still runs alone.

## Open questions for review

1. **Matching.** Is email-then-name-and-company enough to avoid duplicate
   HubSpot records, or should a possible match always be shown for a human
   to decide?
2. **Companies.** Should a sync also create the HubSpot company and
   associate the contact, or contacts only for now?
3. **Edits after sync.** When a teammate adds a touchpoint to a contact
   that's already in HubSpot, does that become a HubSpot note or activity,
   or stay in event-hog?
4. **Who may sync.** Anyone on the team, or only the person who logged the
   contact?
5. **The shared database on ours.** The 2026-10-25 decision says one
   database per client, with no tenant column. Hosting several teams means
   either one D1 database per team (cleanest, more to provision) or a team
   column on every table. Which?
