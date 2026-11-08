# event-hog-mcp

A team working a conference gets one shared workspace in Claude (Desktop,
web, mobile) or Codex. It covers prep before, contacts, notes and slides
during, and follow-ups after. You talk to it in plain words: "who is this?",
"log this person", "who have we met from Schneider?", "write up these slides".

First used for real at the 7x24 Exchange Fall Conference 2026 (San Antonio,
Oct 25–28), with Edviro Energy.

## Why it exists

A conference is days of conversations that matter, and most of them get
lost. Badges get photographed and forgotten. Notes are split across four
phones. Two teammates meet the same person and neither knows. Slides are
photographed and never read again. By the time anyone opens the CRM, the
week is a blur.

event-hog keeps what the team learns while they're still in the room. It
does that without asking anyone to fill in a form, or to stop talking to
the person in front of them.

## What we intend

- **Plain files first.** The record is a folder of markdown files and one
  CSV that anyone can read, with or without us. Databases and CRMs come
  after it. They are views of that folder, and they can be rebuilt from
  it.
- **Credit and no clobbering.** Every entry says who wrote it and when. A
  teammate's write adds to a file and never replaces it.
- **The CRM is a destination, not a requirement.** Pick HubSpot, another
  CRM, or none. With none, contacts stay as files and a CSV you can import
  anywhere.
- **Nothing gets posted.** event-hog drafts posts. A person posts them.
- **Your data is yours.** See [DATA-POLICY.md](DATA-POLICY.md).
- **Given away.** Apache-2.0, with credit appreciated. See [License](#license).

## What it does

**Before the event**
- **Reads the conference for you.** Give it the event's site. It reads the
  agenda and the speaker and sponsor lists, and builds a prep map in
  `prep/`: who's in the room, why they matter, which sessions count, and
  how the team splits up. `new_event` starts the workspace and offers this
  next (the `event-prep` skill).
- **Researches speakers and panelists.** A thin event-app bio, often a
  screenshot, becomes a sourced profile in `speakers/`. It checks their
  social accounts first, then coverage, quotes, and video
  (`augment-speakers-panelists`).

**During the event**
- **Keeps the contact list.** Log someone from a badge photo, a business
  card, a voice memo, or two thumb-typed lines. Each person gets one file.
  Every teammate's interactions append to it, so two people who met the
  same person see each other's notes. Behind the files, a database keeps
  people, organizations, who works where, interactions, observations, and
  places. It answers "who have we met from this company?" or "who's in
  Texas?". `Contacts__Met.csv` stays current.
- **Writes ahead of you.** Before a session it drafts what you'll want:
  flash cards for the acronyms and standards likely to come up, and post
  drafts with `[gaps]` to fill in. After you log something, it fills them
  in from your notes, in the company's voice or your own. It never invents
  what was said (`parallel-content-generation-starters`).
- **Captures slides, with metadata.** Each slide photo is shrunk to the
  smallest size that's still legible, and its location data is stripped.
  It gets notes: a verbatim transcript, the slide type, a one-sentence core
  message, metrics as printed, claims worth checking, and alt text. Each
  session gets a README that tells the talk slide by slide
  (`capture-slides`).
- **Keeps the team in step.** `event_brief`, `recent_activity`, and the
  `daily-brief` prompt answer "who did we meet today, by whom, and which
  priority targets has nobody found yet?".

**After the event**
- **Recreates slides in your brand.** A slide worth keeping is rebuilt as
  a clean slide in your own design system, credited to its source, ready
  for your own decks (`recreate-slides-in-brand`). If you don't have a
  `DESIGN.md` yet, it drafts one from your company's site
  (`maintain-design-system`).
- **Shares the write-up.** Slide notes and recreated slides can be
  published as a page at a link, for people who weren't there.
- **Sends contacts on.** They go to your CRM after you approve, or to an
  import file (see Three ways to run it).

## Three ways to run it

Every way produces the same workspace (see
[`kit/templates/event/`](kit/templates/event/)): `prep/`, `speakers/`,
`contacts/` (one file per person), `notes/`, `slides/`, `drafts/`,
`flash-cards/`, and `Contacts__Met.csv` at the root. Start simple and add
connectors when the team needs them. The files carry over.

### 1. No backend: a zip of markdown files

One person, Claude, and the kit's skills. Claude writes the workspace as
files in its own sandbox and hands it back as a zip. The zip holds
semi-structured markdown with frontmatter and the CSV. There's nothing to
deploy and nothing stored anywhere but your chat and your downloads.

Good for trying it out, or for one person at a small event. The catch is
that it's single player. Teammates can't see each other's contacts until
someone merges the zips.

### 2. Better: shared and versioned on Cloudflare Artifacts

Deploy this server (one Cloudflare Worker) and give each teammate their own
connector link. The workspace becomes a git repo on Cloudflare Artifacts
that the whole team writes to at once. Every contact, note and slide write
is a commit by the person who made it, so you get history, credit and undo.

Two more pieces come with the server:
- **A structured database (SQLite, on Cloudflare D1).** It holds people,
  organizations, who works where, who met whom, and nested locations. It
  answers questions like "who have we met from this company?" or "who's in
  Texas?". It's kept in step with the files.
- **An image host (Cloudflare R2).** Slide photos and other files live here
  at a link. Workspace files keep the link, not the image.

### 3. Best: paired with your CRM

Add a CRM connector next to event-hog in the same chat, and contacts can go
on to your CRM. Each one is proposed first and created only after a person
approves.

- **HubSpot works today.** Pair event-hog with
  [hubspot-mcp-wrap](https://github.com/lossless-group/hubspot-mcp-wrap)
  (our OAuth front door to HubSpot's MCP server) or HubSpot's own
  connector. Claude carries each contact across and records the HubSpot ID.
- **Any other CRM:** `export_hubspot_csv` writes an import file, and
  `Contacts__Met.csv` is always current.
- **Next:** the team picks its CRM once, and event-hog syncs to it itself,
  with one preview and one approval. See
  [`context-v/specs/Pick-a-CRM-and-Go.md`](context-v/specs/Pick-a-CRM-and-Go.md).

## Working on it with us

See [COLLABORATE.md](COLLABORATE.md): how to fork, what to review first,
and the rules for keeping real event data out of the repo.

## How the server works

Three layers, each with one job (the full reasoning is in
[`context-v/decisions/2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog.md`](context-v/decisions/2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog.md)):

| Layer | What | Job |
|---|---|---|
| **Cloudflare Artifacts** | One git repo per event (`event-hog/<yyyy-mm-slug>`), plus `event-hog-kit` | The shared, human-readable record: prep, contacts, notes, slides, drafts. Git history gives attribution and undo |
| **D1 `agnostic-crm`** | SQLite, bound as `CRM` | A structured model of people, organizations, event series and instances, observations, interactions, affiliations and nested locations. Rebuildable from the files |
| **The client's CRM** | HubSpot today | A projection: contacts are proposed, approved, then created through the person's own HubSpot connector |

Plus an R2 bucket, `event-hog-media`, for images and PDFs, served at
`/media/<key>`. Repos hold text and the image's URL, never image bytes.

On every tool call the Worker clones the event repo into memory
(isomorphic-git), changes files, commits as the caller, and pushes. If a
teammate's push lands first, it retries from a fresh clone (up to 5 times).
Writes add files or append to them, so a retry never clobbers anything.

### Routes

| Path | What |
|---|---|
| `POST /mcp/<key>` | The MCP endpoint (JSON-RPC over HTTP). The key identifies the person |
| `GET /media/<key>` | Public files from the bucket. HTML is served with a CSP sandbox: no scripts, no forms |
| `/capture/<token>` | A person's camera page for slide photos. The token is derived from their key |
| `PUT /upload/<ticket>` | A one-time, 15-minute upload link minted by `upload_link` |

### The kit

[`kit/`](kit/) is what goes into the `event-hog-kit` Artifacts repo: the
skills the server serves (`list_skills`, `get_skill`), the template a new
event starts from (`new_event`), and per-deployment settings
(`config/skills.json`, served by `get_config`). Skills are read from the kit
first, then from the CRM deployment's brain repo (`BRAIN_NAMESPACE/SKILLS_REPO`).

## Tools

**Workspace:** `event_brief` (start here), `list_events`, `new_event`,
`whoami`, `list_files`, `read_file`, `search`, `recent_activity`,
`append_to_file`, `add_note`.

**Team:** `list_people` (everyone with access, never their keys), and for
admins `add_person` (makes a teammate's connector URL) and `remove_person`.

**Contacts and CRM:** `log_contact` (appends to an existing contact matched by
email, then name and company), `contacts_csv`, `query_crm`, `relate_orgs`,
`define_location`, `link_location`, `who_is_in`, `crm_queue`,
`mark_crm_synced`, `export_hubspot_csv`.

**Skills:** `list_skills`, `get_skill`, `get_config`, `set_my_research_tools`,
`save_speaker_profile`.

**Slides and files:** `slide_capture_link`, `upload_link`, `slides`,
`view_slide`, `save_slide_notes`, `add_field_note`.

**Brand:** `get_design_system`, `extract_brand`, `save_design_system`,
`save_recreated_slide`.

**Starters:** `save_flash_cards`, `flash_cards`, `save_draft`,
`add_to_draft`, `drafts`.

## What the server guarantees, and what it only asks Claude to do

This is the line to check in review. Some behavior is enforced in code;
some is an instruction to the model (the server's `instructions` and the
skills), which a model can fail to follow.

**Enforced in code:**
- Every write is a commit authored as the caller (`PEOPLE` maps key → name and email).
- Only people marked `"admin": true` in `PEOPLE` can add or remove teammates.
  People added from chat are never admins, and can't be given a teammate's
  email. Their keys are stored only as hashes, `query_crm` refuses to read
  that table, and `list_people` never shows a key.
- Contact and note writes add or append; existing contact fields are filled
  when blank, never overwritten. Slide notes that already exist get "another
  take", not a replacement.
- `mark_crm_synced` records whatever HubSpot ID it's given. It does **not**
  check HubSpot.
- Recreated slides are rejected if they contain `<script>` or lack a credit
  line. The credit check is loose: the words "source", "adapted from" or
  "via" anywhere in the text pass it. All HTML under `/media/` is served
  sandboxed.
- Upload links: signed (HMAC keyed by the person's connector key), expire in
  15 minutes, single use, and the file's first bytes must match its type.

**Asked of the model, not enforced:**
- Search before logging a contact; never invent fields.
- Propose CRM records and create them only after the person approves. The
  server never calls HubSpot; Claude does, through the person's own HubSpot
  connector.
- Nothing is ever posted publicly: drafts only.
- Discretion rules for posts (hallway conversations stay private, and so on).

## Your data

On your own Cloudflare account, your data never reaches us. On the
deployment we run, [DATA-POLICY.md](DATA-POLICY.md) applies: stored so your
team can use it, never looked at or used commercially.

## Security model, plainly

- **The connector URL is the credential.** Anyone with `…/mcp/<key>` acts as
  that person. There is no sign-in yet. Treat the URL like a password.
- **Everyone with access sees every event.** There's no per-event
  membership: anyone in `PEOPLE` or added with `add_person` can read and
  write every event on the server, contacts included.
- **`add_person` returns the new URL in the chat.** It's shown once and not
  stored, but it stays in that conversation's history. `remove_person`
  revokes it.
- **`/media/` is public.** Anyone with a file's URL can open it. Keys the server writes
  include random parts, so its URLs can't be guessed, but don't put anything there you
  wouldn't share by link.
- **`config/skills.json` is served to every connector user.** Settings only,
  never credentials.

## Known gaps (for 0.1.0)

- `npx wrangler dev` fails locally: `src/index.ts` exports plain constants
  (`DIR`, `CONTACTS_CSV`), which the local runtime treats as handlers.
  Production accepts them.
- "CRM-agnostic" is half true: the database model is ours, but the sync step
  (`hubspot_status`, `crm_queue`, `export_hubspot_csv`) only knows HubSpot.
- Every call clones the whole event repo. Fine for one event's worth of
  text; slower as repos grow.
- The used-upload-link marker is check-then-write, not atomic.
- `event-prep` isn't in `kit/` yet. It lives in
  [lossless-agent-skills](https://github.com/lossless-group/lossless-agent-skills),
  and it was written for our Twenty CRM. It needs an event-hog-shaped copy
  in the kit.
- The no-backend way has no skill of its own yet. The kit's skills name
  event-hog's tools, so without the server Claude has to follow the
  template's layout itself.
- Not yet verified end to end: a slide sent with `upload_link` from Claude's
  sandbox, which also needs the Claude org admin to allow this Worker's host
  for code execution.

## Deploy your own

You need a Cloudflare account with Artifacts, D1 and R2.

```bash
npm install
npx wrangler d1 create agnostic-crm          # put its id in wrangler.jsonc
npx wrangler r2 bucket create event-hog-media
npx wrangler d1 migrations apply agnostic-crm --remote
```

1. Fill in the `<...>` values in `wrangler.jsonc`, including `PUBLIC_URL`.
2. Create the `event-hog-kit` repo in your Artifacts namespace and push
   `kit/` into it. Copy `kit/config/skills.example.json` to
   `config/skills.json` and fill it in.
3. Set the people: `npx wrangler secret put PEOPLE`, a JSON map of connector
   key → `{ "name", "email", "emails"?, "crm_email"?, "admin"? }`. Generate
   each key with `openssl rand -hex 24`. Mark at least one person
   `"admin": true` so they can add teammates from chat (`add_person`), which
   stores them in D1 instead of this secret.
4. `npx wrangler deploy`.
5. Each person adds `https://<your worker>/mcp/<their key>` in Claude as a
   custom connector. Then ask Claude to start a new event (`new_event`).

`seeds/` has the 7x24 Exchange Fall 2026 instance as an example seed.

## Developing

```bash
npm run check    # tsc --noEmit
```

Commit messages follow the
[Lossless git conventions](https://github.com/lossless-group/lossless-agent-skills/tree/main/git-conventions).

## License

Apache-2.0. See [LICENSE](LICENSE). Keep [NOTICE](NOTICE) in any copy or fork:
it credits The Lossless Group.
