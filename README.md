# event-hog-mcp

[![A conference badge on a blue lanyard: "Hello, we are event-hog. Your team's memory at the show." Work the room. Keep everything.](https://eventhog.cc/ogimage__Event-Hog--Banner.jpg)](https://eventhog.cc)

**[eventhog.cc](https://eventhog.cc)**

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

## Getting someone connected

On the deployment we run, that's [eventhog.cc](https://eventhog.cc/#connect).
On your own, open the Worker's home page (`https://<your worker>/`). Press
**Copy this prompt**. The prompt carries a personal connector link (a random key made in
the browser) and tells the person's agent how to add it: Cursor and Claude
Code and Codex add it themselves; Claude and ChatGPT apps walk the person
through Settings, Connectors. Then the agent calls `get_started`, which asks:

1. Which company do you represent?
2. Which conference are you going to?

It finds (or starts, with `new_event`) the event's workspace, works out from
the dates whether they're **before**, **during** or **after** it, and returns
that phase's playbook:

- **Before:** pull the attendee list (`conference-attendee-export`), save it
  (`save_attendees`), research and rank who's worth finding
  (`prioritize-attendees`, `enrich_people`, `save_targets`), and show the
  shortlist.
- **During:** how to log someone in a sentence or a badge photo
  (`log_contact`), "who should I find next?" (`targets`), and the slide
  camera page.
- **After:** who to follow up with, most important first; how to get
  contacts into their CRM through their own CRM connector (EventHog never
  writes to a CRM itself); follow-up emails (`draft-follow-up-emails`); and
  Origami for sending at scale.

What a key the server hasn't seen does depends on `SELF_SERVE`:

- **`"teams"`** (the deployment we run): it starts a new, private team, and
  that person is its admin. They invite teammates with `add_person`. Each
  team has its own events, contacts, slides and database, and no other team
  on the server can see them. The deployment's own team (the "home" team,
  Edviro on ours) keeps its data where it always was.
- **`"open"`**: it joins the home team (the `members` table in D1).
- **Unset**: the server is invite-only. People come from an admin's
  `add_person` (or the `PEOPLE` secret), and a landing-page key gets a 401.

One connector URL reaches one team. Someone with a team of their own who is
invited to another gets a second URL; both keep working and nothing is
merged.

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

### Teams

The Worker resolves the connector key against the registry in D1
(`connector_people` and `teams`). The home team's calls run in the Worker,
against `agnostic-crm` and unprefixed repos, as above. Every other team's
calls, slide captures and uploads go to that team's Durable Object (`Team`,
[`src/team-do.ts`](src/team-do.ts)), one per team, which runs the same tools
against:

- its own SQLite database, with the CRM schema from `migrations/` (bundled
  into `src/migrations.generated.ts` at build time);
- repos named `tm-<team id>-<event>`, plus `tm-<team id>-kit` for its
  settings and brand (made on first write; until then the bundled kit is
  used);
- media under `teams/<team id>/` in the bucket.

`open()` refuses any repo outside the caller's team, so a team can't name
another team's event, and the home team can't name a `tm-` repo. Teams are
capped at 20 events and 25 connectors, and at most `MAX_NEW_TEAMS_PER_DAY`
(default 50) new teams start per day. `enrich_people`, which spends the
deployment's own context.dev credits, works only for the home team.

### Routes

| Path | What |
|---|---|
| `GET /` | The landing page: copy the connect prompt with a personal link (an invite-only notice unless `SELF_SERVE` is set) |
| `POST /mcp/<key>` | The MCP endpoint (JSON-RPC over HTTP). The key identifies the person. Opened in a browser, it explains itself instead |
| `GET /media/<key>` | Public files from the bucket. HTML is served with a CSP sandbox: no scripts, no forms |
| `/capture/<token>` | A person's camera page for slide photos. The token is derived from their key |
| `PUT /upload/<ticket>` | A one-time, 15-minute upload link minted by `upload_link` |

### The kit

[`kit/skills/`](kit/skills/) and [`kit/templates/`](kit/templates/) are
bundled into the Worker at build time (`scripts/bundle-kit.mjs` writes
`src/kit.generated.ts`; wrangler's build command runs it). So the skills
the server serves (`list_skills`, `get_skill`) and the template a new event
starts from (`new_event`) ship with every deploy and are versioned with the
code, with no git clone per call. This follows Cloudflare's Agent Skills
pattern: bundled skills first, then optional remote sources that are skipped
if they fail to load. Here the optional source is the CRM deployment's brain
repo (`BRAIN_NAMESPACE/SKILLS_REPO`).

What's written at runtime stays in the `event-hog-kit` Artifacts repo:
per-deployment and per-person settings (`config/skills.json`, served by
`get_config`, written by `set_my_research_tools`) and brand design systems
(`brand/<name>/DESIGN.md`).

Kit skills: `conference-attendee-export`, `prioritize-attendees`,
`augment-speakers-panelists`, `parallel-content-generation-starters`,
`capture-slides`, `recreate-slides-in-brand`, `maintain-design-system`,
`draft-follow-up-emails`.

## Tools

**Getting started and prep:** `get_started` (first time), `save_my_profile`,
`save_attendees`, `enrich_people`, `save_targets`, `targets`.

`enrich_people` looks roster entries (name and company) up through
[context.dev](https://www.context.dev)'s People Enrich with the deployment's
key, so nobody connecting needs an account: current title and employer,
LinkedIn, sometimes a work email, and a match band (confirmed at score 70+,
unconfirmed at 40 to 69). Every answer, misses included, is cached in the
`enrichments` table, so the team never pays twice for one person. A match
costs 20 credits and a miss is free (the free tier is 1,000 credits a month).
Without the key, or out of credits, it tells the agent to use web search.

**Next steps:** `what_can_i_do` lists what the person can say right now, for
before, during or after the event. Most tools also end their result with a
"Next:" line of follow-on offers, and the server asks the agent to close each
reply with two or three of them, so nobody has to know the tool list.

**Workspace:** `event_brief`, `list_events`, `new_event`,
`whoami`, `list_files`, `read_file`, `search`, `recent_activity`,
`append_to_file`, `add_note`.

**Team:** `list_people` (everyone on the caller's team, never their keys),
and for admins `add_person` (makes a teammate's connector URL) and
`remove_person`. Admins on the home team also get `delete_team` (see
Deleting a team).

**Contacts and CRM:** `log_contact` (appends to an existing contact matched by
email, then name and company), `contacts_csv`, `query_crm`, `relate_orgs`,
`define_location`, `link_location`, `who_is_in`, `crm_queue`,
`mark_crm_synced`, `export_hubspot_csv`.

`crm_queue` and `export_hubspot_csv` cover everyone the team met at the event
by default. `met_by` narrows them to the contacts certain people met
(`["me"]`, or `["me", "Michael"]`), matched against who logged each
touchpoint; a name that fits two people is rejected rather than guessed.
`owner: "me"` makes the caller the CRM owner of every contact instead of
whoever first logged them.

Conversations go too: `crm_queue` lists every touchpoint not yet in HubSpot
for the agent to log as a completed meeting on the contact (owned by whoever
had the conversation, titled "Met at <event>", with where and the notes), and
every open follow-up as a task. `mark_touchpoints_synced` records the meeting
and task IDs in `crm_links`, so nothing is logged twice, and a touchpoint
added after the contact was synced still shows up next time. The CSV export
carries contacts only.

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
- Every write is a commit authored as the caller (the registry maps key → name and email).
- A team's tools only reach its own database, `tm-<id>-` repos and
  `teams/<id>/` media; the home team can't reach any team's either.
  `scripts/isolation-test.mjs` checks this against a running server.
- Only admins can add or remove teammates: whoever started a team, people
  marked `"admin": true` in `PEOPLE`, or landing-page connectors whose
  `members.admin` is 1 (set by whoever runs the deployment, with
  `wrangler d1 execute`; no tool writes it). People added from chat are never
  admins, and can't be given an email already on their team. Their keys are
  stored only as hashes, and `list_people` never shows a key.
- `query_crm` refuses to read `connector_people`, `members` and `teams`.
- A key from the landing page works only while `SELF_SERVE` is set. A
  profile saved with `save_my_profile` never grants access by itself, so
  taking someone out of `PEOPLE`, or `remove_person`, locks them out.
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
  that person. There is no sign-in yet. Treat the URL like a password. Keys
  are stored as written in the `PEOPLE` secret and the `members` table;
  `connector_people` (`add_person`, team signups) keeps only a hash.
- **Joining is closed unless you open it.** Without `SELF_SERVE`, only
  `PEOPLE` and `add_person` grant access, and a key from the landing page
  gets a 401. With `"teams"`, a stranger's key starts a team of its own and
  sees nothing else. With `"open"`, it joins the home team and its
  workspace: fine for one team, not for strangers.
- **Everyone on a team sees every event in it.** There's no per-event
  membership: anyone on a team can read and write all of its events,
  contacts included. `list_people` shows them all.
- **Teams are separated by code, not by account.** They share one Worker,
  one Artifacts namespace and one bucket, so whoever runs the deployment can
  reach every team's data (see [DATA-POLICY.md](DATA-POLICY.md)).
- **`add_person` returns the new URL in the chat.** It's shown once and not
  stored, but it stays in that conversation's history. `remove_person`
  revokes it.
- **`/media/` is public.** Anyone with a file's URL can open it. Keys the server writes
  include random parts, so its URLs can't be guessed, but don't put anything there you
  wouldn't share by link.
- **`config/skills.json` is served to every connector user.** Settings only,
  never credentials.

## Known gaps (for 0.1.0)

- A connector reaches one team. Nobody can switch a connector between teams,
  merge two teams, or delete their own team from chat (the operator does it,
  on request).
- "CRM-agnostic" is half true: the database model is ours, but the sync step
  (`hubspot_status`, `crm_queue`, `export_hubspot_csv`) only knows HubSpot.
- Every call clones the whole event repo. Fine for one event's worth of
  text; slower as repos grow.
- The used-upload-link marker is check-then-write, not atomic.
- `event-prep` isn't in `kit/` yet. It lives in
  [lossless-agent-skills](https://github.com/lossless-group/lossless-agent-skills),
  and it was written for our Twenty CRM. `get_started`'s "before" playbook
  covers the attendee side (`conference-attendee-export`,
  `prioritize-attendees`); agenda and sponsor research still need it.
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
2. Create the `event-hog-kit` repo in your Artifacts namespace for runtime
   settings: copy `kit/config/skills.example.json` to `config/skills.json`
   and fill it in. (Skills and the event template are bundled; they don't
   need pushing.)
3. Set the people: `npx wrangler secret put PEOPLE`, a JSON map of connector
   key → `{ "name", "email", "emails"?, "crm_email"?, "admin"? }` (keys from
   `openssl rand -hex 24`). Mark at least one person `"admin": true` so they
   can add teammates from chat (`add_person`), which stores them in D1
   instead of this secret. (`PEOPLE` can't be read back, so to make an admin
   later without re-entering it, a connector that joined from the landing
   page can be marked instead: `UPDATE members SET admin = 1 WHERE
   self_serve = 1 AND email = '…'` with `npx wrangler d1 execute <db> --remote`.)
4. Optional: `npx wrangler secret put CONTEXT_DEV_API_KEY` (a key from the
   [context.dev dashboard](https://www.context.dev/dashboard/api-keys)) to
   turn on `enrich_people`.
5. Optional: to let people start from the landing page, set `SELF_SERVE` in
   `vars`: `"teams"` gives each signup a private team of its own, `"open"`
   adds them to yours. Leave it out and the server is invite-only.
6. `npx wrangler deploy` (the build step bundles `kit/`; the first deploy
   also creates the `Team` Durable Object class from `migrations` in
   `wrangler.jsonc`).
7. Each person adds `https://<your worker>/mcp/<their key>` in Claude as a
   custom connector. (With `SELF_SERVE` set, they can instead copy the
   connect prompt from `https://<your worker>/`.)

### Deleting a team

When a team asks to leave, an admin on the home team does it from chat:

1. `delete_team` with no arguments lists the teams: id, name, when it
   started, and how many connectors it has.
2. `delete_team` with `team` set shows what would go: its connectors, its
   `tm-<id>-*` repos, its database and its `teams/<id>/` files.
3. If they want a copy first, export it before deleting: `contacts_csv` from
   one of their connectors, or clone the `tm-<id>-*` repos.
4. `delete_team` with `team` and `confirm` both set to the id deletes it. Its
   connectors stop working, the repos, files and Durable Object are erased,
   and only the connectors' key hashes stay, marked removed, so an old URL
   can't start a new team. If a step fails, run it again: the team stays
   listed until everything is gone.

Keep a deployment's real values (D1 id, URL) in its own
`wrangler.<name>.jsonc`, which git ignores, and deploy with
`npx wrangler deploy -c wrangler.<name>.jsonc`.

### Deploy on every push

`.github/workflows/deploy-worker.yml` applies D1 migrations and deploys
whenever `main` changes code, skills or migrations. It runs only in the repo
named in its `if:` (Edviro's fork). That repo needs three Actions secrets:

- `CLOUDFLARE_API_TOKEN`: a token from the "Edit Cloudflare Workers"
  template, plus D1 Edit.
- `CLOUDFLARE_ACCOUNT_ID`.
- `WRANGLER_CONFIG_B64`: the deployment's `wrangler.<name>.jsonc`, base64.
  After changing that file, update it with
  `base64 -i wrangler.<name>.jsonc | gh secret set WRANGLER_CONFIG_B64`.

`seeds/` has the 7x24 Exchange Fall 2026 instance as an example seed.

## Developing

```bash
npm run check    # tsc --noEmit
npx wrangler dev -c wrangler.<name>.jsonc
node scripts/isolation-test.mjs http://localhost:8787 <home admin key>   # with SELF_SERVE "teams"
```

The isolation script starts two teams, checks neither can reach the other's
data (nor the home team theirs), then deletes both with `delete_team`.

Commit messages follow the
[Lossless git conventions](https://github.com/lossless-group/lossless-agent-skills/tree/main/git-conventions).

## License

Apache-2.0. See [LICENSE](LICENSE). Keep [NOTICE](NOTICE) in any copy or fork:
it credits The Lossless Group.
