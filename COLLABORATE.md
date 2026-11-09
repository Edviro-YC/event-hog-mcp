# Collaborating on event-hog

event-hog is built by The Lossless Group with the teams who use it. It
started with Edviro, at a real event, and their fork is where the next
changes get tested. This file covers how we work on it together.

## Who's who

- **lossless-group/event-hog-mcp** (this repo) is upstream. Changes that are
  useful to any team land here.
- **A team's fork** (for example Edviro's) holds that team's deployment
  settings and anything specific to them. When something in a fork would
  help everyone, send it upstream as a pull request.
- **[hubspot-mcp-wrap](https://github.com/lossless-group/hubspot-mcp-wrap)**
  is a separate repo. It's the HubSpot side of the CRM pairing.

## Start here if you're reviewing

The question a review has to answer is **does it do what we think it does?**
Read in this order:

1. [README: What the server guarantees, and what it only asks Claude to
   do](README.md#what-the-server-guarantees-and-what-it-only-asks-claude-to-do).
   Each line under "Enforced in code" should be checkable in `src/`. Each
   line under "Asked of the model" is a risk worth naming.
2. [README: Security model](README.md#security-model-plainly) and
   [Known gaps](README.md#known-gaps-for-010).
3. [`context-v/decisions/`](context-v/decisions/): why it has three layers.
4. [`context-v/specs/Pick-a-CRM-and-Go.md`](context-v/specs/Pick-a-CRM-and-Go.md):
   the next big change, with its open questions at the end.
5. `src/index.ts`. It holds the tool list and the router. Then read the module
   for whichever tool you're checking.

If you find that the code and the README disagree, open an issue. If the
code is right, fix the README. If the README is right, fix the code.

## How to contribute

1. Fork, then branch from `main`.
2. `npm install` then `npm run check`. It must pass.
3. Keep each change focused. Commit messages follow the
   [Lossless git conventions](https://github.com/lossless-group/lossless-agent-skills/tree/main/git-conventions):
   an action word, the area, then a sentence about what it does for the
   people using it. For example: `fix(event-hog): Stop a retry from dropping a teammate's note`.
4. If a change alters what the server guarantees, update that README
   section in the same pull request.
5. Open a pull request against `main` here. Say what you tested, and how:
   ideally a deployed Worker and a real Claude chat. For anything touching
   access or teams, also run `scripts/isolation-test.mjs` against
   `wrangler dev` with `SELF_SERVE: "teams"` (README: Developing).
6. Add a file to `changelog/` (`YYYY-MM-DD_NN.md`, same front matter as the
   others) saying what changed for the people using it.

Bigger changes start as a spec in `context-v/specs/` and get discussed
before anyone writes code. The CRM work is the example.

## Where things go

| Change | Where |
|---|---|
| Server behavior, tools | `src/` |
| Database shape | a new file in `migrations/`, never an edit to an old one |
| A playbook Claude follows (`SKILL.md`) | `kit/skills/`. Skills that started in [lossless-agent-skills](https://github.com/lossless-group/lossless-agent-skills) (`augment-speakers-panelists`) get edited there first, then copied here |
| The layout of a new event | `kit/templates/event/` |
| Plans, decisions, problems we hit | `context-v/` (`specs/`, `decisions/`, `issues/`) |

## Never commit real event data

This repo is public. Keep these in your deployment or your fork's private
settings, and never in a commit:

- Contacts, notes, attendee lists, slide photos, or anything else from a
  real event workspace.
- Connector keys, the `PEOPLE` secret, API tokens, `.env` files.
- A team's real `config/skills.json` (it has names and emails) and its
  brand files. The repo ships `skills.example.json` instead.
- Real IDs: D1 database ids, KV ids, CRM portal ids. `wrangler.jsonc` keeps
  `<placeholders>`.

If you work on the deployment we run, [DATA-POLICY.md](DATA-POLICY.md)
binds you too. You don't look at a team's data unless that team asks you to
help, and you never use it for anything else.

## Releases

Versions follow semver, starting at 0.1.0 after the first joint review.
Each release gets a tag and a note on what changed for the people using it.

## License

Apache-2.0. By contributing, you agree your contribution is under the same
license. Keep [NOTICE](NOTICE) in forks: it credits The Lossless Group.
