// event-hog: a remote MCP server over Cloudflare Artifacts.
//
// One Artifacts repo per event (namespace `event-hog`). Everyone on the team adds
// the same server to Claude as a custom connector, each with their own key in the
// URL, so every write is a git commit authored by the person who made it.
//
// Reads and writes both go through git: the Artifacts binding manages repos and
// mints tokens, but can't write files, so each request clones the repo into an
// in-memory filesystem with isomorphic-git, works on it, and (for writes) commits
// and pushes. A push rejected because a teammate pushed first is retried from a
// fresh clone. Writes add files or append to them, so a retry just re-applies.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { CRM_TOOLS, CRM_HANDLERS, recordContact, recordCrmLink } from "./crm";
import { LOCATION_TOOLS, LOCATION_HANDLERS } from "./locations";
import { SKILL_TOOLS, SKILL_HANDLERS, SKILL_PROMPTS } from "./skills";
import { STARTER_TOOLS, STARTER_HANDLERS, STARTER_PROMPTS, STARTER_NUDGES } from "./starters";
import { SLIDE_TOOLS, SLIDE_HANDLERS, SLIDE_PROMPTS, handleCapture, serveMedia } from "./slides";
import { BRAND_TOOLS, BRAND_HANDLERS, BRAND_PROMPTS } from "./brand";
import { EVENT_TOOLS, EVENT_HANDLERS, withCurrentEvent, forEvent, eventsTable } from "./events";
import { UPLOAD_TOOLS, UPLOAD_HANDLERS, handleUpload, uploadTeam } from "./uploads";
import { TEAM_TOOLS, OPERATOR_TOOLS, TEAM_HANDLERS, personForKey, personForCaptureToken, allPeople, selfServeOpen, looksSelfServe, SignupsPaused, teamName } from "./team";
import type { Team } from "./team-do";
import { ONBOARDING_TOOLS, ONBOARDING_HANDLERS, ONBOARDING_PROMPTS } from "./onboarding";
import { ENRICH_TOOLS, ENRICH_HANDLERS } from "./enrich";
import { SUGGESTION_TOOLS, SUGGESTION_HANDLERS, NEXT_STEPS } from "./suggestions";
import { landingPage, connectorPage } from "./landing";
import { KIT } from "./kit.generated";

export interface Env {
  ARTIFACTS: any;
  BRAIN: any;
  BRAIN_NAMESPACE: string;
  SKILLS_REPO: string;
  KIT_REPO: string;
  CRM: any;
  PEOPLE: string;
  ACCOUNT_ID?: string;
  DEFAULT_EVENT: string;
  NAMESPACE: string;
  EVENT_TIMEZONE: string;
  /** Image host: slide photos and other media, served at /media/<key>. */
  MEDIA: any;
  /** Public base URL, for links the server hands out (capture pages, media). */
  PUBLIC_URL: string;
  /** Where GET / sends people, if the copy-a-prompt page lives elsewhere (eventhog.cc). Unset: this Worker serves its own. */
  HOME_URL?: string;
  /** "teams": a new key from the landing page starts its own team. "open": it joins the home team. Unset: only add_person grants access. */
  SELF_SERVE?: string;
  /** Cap on teams started from the landing page per 24 hours (default 50). */
  MAX_NEW_TEAMS_PER_DAY?: string;
  /** The home team's name, for whoami and list_people ("Edviro"). */
  HOME_TEAM_NAME?: string;
  /** Secret: context.dev key behind enrich_people. Without it the tool says to use web search. */
  CONTEXT_DEV_API_KEY?: string;
  /** One Durable Object per team other than home: its database and its tool calls. */
  TEAM: DurableObjectNamespace;
  // Set only inside a team's Durable Object (team-do.ts teamEnv):
  /** The main D1, for the registry (connector_people, teams), while CRM is the team's own database. */
  ACCESS_DB?: any;
  TEAM_ID?: string;
  /** Prefix on the team's repo names: tm-<id>-. */
  TEAM_PREFIX?: string;
  /** Prefix on the team's media keys: teams/<id>/. */
  MEDIA_PREFIX?: string;
}

export interface Person {
  name: string;
  /** Primary address: what commits are authored as. */
  email: string;
  /** Every other address that is this person (work, personal, aliases). */
  emails?: string[];
  /** The address their CRM (HubSpot) knows them by: owners and "created by" match on it. */
  crm_email?: string;
  /** Can add and remove teammates from chat: a team's founder, connector_people.admin, members.admin, or "admin": true in PEOPLE. */
  admin?: boolean;
  /** The connector key this request came in on. */
  key?: string;
  /** Where their access comes from: the PEOPLE secret, add_person, or the landing page. */
  via?: "secret" | "added" | "self-serve";
  /** Their team's id, if it isn't the home team. */
  team?: string;
  /** Their team's name: the founder's company. */
  team_name?: string;
  /** The company they represent at events, and who buys from it. */
  company?: string;
  company_url?: string;
  ideal_customer?: string;
  /** A self-serve connector that hasn't saved a name yet. */
  guest?: boolean;
}

/** The address to use anywhere a CRM attributes work to this person. */
export function crmEmail(p: Person): string {
  return (p.crm_email ?? p.email).trim().toLowerCase();
}

/** All of a person's addresses, primary first, lowercased and de-duplicated. */
export function identities(p: Person): string[] {
  return [...new Set([p.email, ...(p.emails ?? []), p.crm_email ?? ""].filter(Boolean).map((e) => e.trim().toLowerCase()))];
}

export const DIR = "/repo";
const SERVER = { name: "event-hog", version: "0.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `event-hog is a shared workspace for a team working an event together: prep before, contacts and notes during, follow-ups after. Every write is a git commit attributed to the person using this connector.

How to use it:
- First time, or when someone says "get started" or "set me up": call get_started and follow what it returns. It asks which company they represent and which conference they're going to, then gives the playbook for before, during, or after the event. If whoami says the connector has no name yet, do this before anything else.
- Keep the person moving: end every reply with one short line of 2 or 3 things they could say next, in their words, not tool names (e.g. 'You could also say: "who should I find next?" · "write up my slides"'). Fit them to the phase (before: who to find, speakers, jargon; during: log people, who's next, slides, daily brief; after: follow-ups, CRM, emails, posts). Tool results often end with a "Next:" list to pick from; once a conversation, suggest something they haven't used yet (badge photos, the slide camera, flash cards, enrichment, CRM sync). If they ask what event-hog can do or seem unsure, call what_can_i_do. Skip the line while they're logging people rapid-fire.
- Skills: list_skills shows the team's playbooks; get_skill loads one before doing that kind of work (e.g. augment-speakers-panelists when someone shares a speaker card or asks who a speaker is). get_config returns this person's and the organization's settings for a skill, such as which research tools to use.
- Starters: whenever someone logs a contact, adds a note, or saves a speaker profile, load parallel-content-generation-starters (once per conversation) and follow it. Answer the person first; starters come after, short, and never block logging. Flash cards for acronyms, vocabulary, concepts and market standards go in the shared deck with save_flash_cards; flash_cards reads it. Post drafts (tweets, threads, LinkedIn, blog) go in drafts/ with save_draft and add_to_draft, in the company voice for official pieces and the person's own voice for theirs (get_config). Nothing is ever posted from here.
- Slides and other images: an image attached in chat can't be passed to a tool. If you have a code-execution sandbox, the attachment is a file there: upload_link gives a one-time URL to send it to the event's image host with curl (slides become slides waiting for notes; badges, cards, photos and PDFs return a /media/ URL to put in the contact or note). If the sandbox can't reach the host, or there is none, give the person their slide_capture_link (a camera page that shrinks and saves photos under their name) and don't retry the upload. Then list slides needing notes, look at each with view_slide, and write them up with save_slide_notes (load the capture-slides skill first).
- Brand: get_design_system returns the organization's DESIGN.md; if there is none, extract_brand reads the company site and maintain-design-system says how to draft one. When a batch of slides is written up, ask whether any are worth recreating in the brand (recreate-slides-in-brand); every recreation credits its source on the slide.
- Team: each connector belongs to one team, and a team's events, contacts and slides are private to it (whoami says which team). list_people shows everyone on the team. Admins (whoever started the team, at first) add a teammate with add_person, which returns that teammate's personal connector URL once: confirm the name and email first, and tell the person to send the URL privately. remove_person revokes someone.
- Start with event_brief to see the event, the team, the prep docs, and what's been logged. Tools use the current event (the one on today, else one that ended in the last week, else the next) unless you pass event; list_events shows them all. new_event starts a workspace for a new event from the kit's template: confirm the official name, dates, city and time zone with the person first, then offer the event-prep skill.
- Before logging a contact, search for them: log_contact appends to an existing contact (matched by email, then name) instead of making a duplicate, but a quick search shows what teammates already know.
- log_contact takes whatever the person gives you: a typed note, a badge or business-card photo you've read, or a voice memo transcript. Never invent fields. Leave unknown ones out.
- Contacts__Met.csv at the workspace root lists everyone the team met, regenerated on every log_contact; contacts_csv rebuilds and returns it. Attendee lists in prep/ are reference, not contacts: never log someone as a contact from an attendee list alone.
- add_note is for anything that isn't one person: a session takeaway, a theme from the floor, an idea.
- recent_activity shows what teammates logged and when.
- Locations are human-defined and nested (define_location); a person or org can have many (link_location), and who_is_in finds everyone inside a place, nested places included.
- query_crm answers structured questions (who at an org have we met, which orgs relate to which, open follow-ups) from the team's agnostic-crm database, which log_contact keeps in step with the files.
- CRM: contacts start as hubspot_status pending. If the user has a HubSpot connector, crm_queue lists what's pending: everyone the team met by default, or only the contacts certain people met with met_by (["me"], or ["me", "Michael"]). Each pending contact shows who logged it and their HubSpot email: make that HubSpot user the contact owner (find them with search_owners by that email). Propose the HubSpot records, create them only after the user approves, then call mark_crm_synced with the HubSpot ID. crm_queue also lists conversations not yet in HubSpot: log each as a completed meeting associated with the contact (owned by whoever had it) and each follow-up as a task, then call mark_touchpoints_synced with their IDs. Never mark something synced that wasn't created.
- If the HubSpot connection isn't working (no HubSpot connector, sign-in fails, or HubSpot calls error), don't keep retrying and don't stop logging. log_contact is the raw record: it saves every contact to the shared files and the agnostic-crm database whether or not HubSpot works. At each stopping point (end of a conversation, a break, end of the day) run export_hubspot_csv: it writes everyone still pending into a HubSpot-ready import file, committed under exports/, for a bulk import later. Tell the user that's what happened.`;

// ---------------------------------------------------------------- entry point

// The Worker is the front door: it resolves who is calling, then runs the
// home team's calls itself (CRM is the main D1) and hands every other team's
// to that team's Durable Object (team-do.ts), one RPC per request.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/media/") && request.method === "GET") return serveMedia(env, url.pathname.slice(7));

    // Upload links carry their event, so they skip the current-event lookup.
    const upload = url.pathname.match(/^\/upload\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if (upload) {
      const team = await uploadTeam(env, upload[1]);
      return team ? teamStub(env, team).upload(request, team, upload[1]) : handleUpload(request, env, upload[1]);
    }
    const capture = url.pathname.match(/^\/capture\/([a-f0-9]{32})\/?$/);
    if (capture) {
      const team = (await personForCaptureToken(env, capture[1]))?.person.team;
      return team ? teamStub(env, team).capture(request, team, capture[1]) : handleCapture(request, await withCurrentEvent(env), capture[1]);
    }
    const match = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{16,})\/?$/);

    if (url.pathname === "/" && request.method === "GET") {
      if (env.HOME_URL) return Response.redirect(env.HOME_URL, 302);
      // The landing page mints keys; while joining is closed they wouldn't work.
      if (!selfServeOpen(env)) return new Response("This event-hog server is invite-only. Ask its admin for your own connector URL.\n");
      return landingPage(url.origin, env.SELF_SERVE === "teams");
    }
    if (!match) return new Response("Not found", { status: 404 });

    // Someone opened their connector link in a browser: explain it, create nothing.
    if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) {
      return connectorPage(`${url.origin}/mcp/${match[1]}`, env.HOME_URL ?? "/");
    }

    let person: Person | null;
    try {
      person = await personForKey(env, match[1]);
    } catch (err) {
      if (err instanceof SignupsPaused) return new Response(err.message, { status: 503 });
      throw err;
    }
    if (!person && looksSelfServe(match[1]) && !selfServeOpen(env)) {
      return new Response("This event-hog server is invite-only. Ask its admin for your own connector URL.", { status: 401 });
    }
    if (!person) return new Response("Unknown connector key", { status: 401 });

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return rpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }

    const out = person.team
      ? await teamStub(env, person.team).call(body, person)
      : await respond(body, await withCurrentEvent(env), person);
    return out ? rpcResponse(out) : new Response(null, { status: 202 });
  },
};

// The RPC methods of a team's Durable Object (team-do.ts).
type TeamStub = Pick<Team, "call" | "capture" | "upload">;
const teamStub = (env: Env, team: string) => env.TEAM.getByName(team) as unknown as TeamStub;

function rpcResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

/** Answer one JSON-RPC message or a batch: null when there's nothing to send back. */
export async function respond(body: any, env: Env, person: Person): Promise<unknown> {
  if (!Array.isArray(body)) return handle(body, env, person);
  const out = (await Promise.all(body.map((m) => handle(m, env, person)))).filter(Boolean);
  return out.length ? out : null;
}

export function people(env: Env): Record<string, Person> {
  try {
    return JSON.parse(env.PEOPLE || "{}");
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- JSON-RPC

async function handle(msg: any, env: Env, person: Person): Promise<any | null> {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: { tools: {}, prompts: {} },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: !env.TEAM_ID && person.admin ? [...TOOLS, ...OPERATOR_TOOLS] : TOOLS });
      case "tools/call": {
        const tool = HANDLERS[params?.name];
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const out = await tool(params?.arguments ?? {}, await forEvent(env, params?.arguments?.event), person);
          if (typeof out !== "string") return reply(out);
          const extras = [STARTER_NUDGES[params?.name], NEXT_STEPS[params?.name]].filter(Boolean);
          return reply({ content: [{ type: "text", text: [out, ...extras].join("\n\n") }] });
        } catch (err: any) {
          return reply({ content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true });
        }
      }
      case "prompts/list":
        return reply({ prompts: PROMPTS.map(({ text, ...p }) => p) });
      case "prompts/get": {
        const p = PROMPTS.find((x) => x.name === params?.name);
        if (!p) return fail(-32602, `Unknown prompt: ${params?.name}`);
        return reply({ description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text } }] });
      }
      case "resources/list":
        return reply({ resources: [] });
      case "resources/templates/list":
        return reply({ resourceTemplates: [] });
      default:
        if (isNotification) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err: any) {
    return isNotification ? null : fail(-32603, err?.message ?? String(err));
  }
}

// ---------------------------------------------------------------- git workspace

export interface Workspace {
  fs: MemoryFS;
  remote: string;
  onAuth: () => { username: string; password: string };
}

// "event" repos live in the event-hog namespace (one per event instance);
// "brain" repos in hubspot-brain (shared skills and configuration).
export type Space = "event" | "brain";

const noEvent = (event: string) => `There's no event workspace called "${event}" yet. Run get_started (or list_events, or new_event to start one).`;

// A team other than home has repos named tm-<id>-<name> in the shared
// namespace; tools and people only ever see <name>. Every repo access goes
// through here, so no name can reach another team's repos.
export function repoFor(env: Env, event: string): string {
  const name = String(event ?? "").trim();
  if (!name) throw new Error("There's no event yet. Run get_started to find or start one (or new_event).");
  if (name === env.KIT_REPO) return name;
  const prefix = env.TEAM_PREFIX ?? "";
  const bare = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  if (bare.startsWith("tm-")) throw new Error(noEvent(name));
  return prefix + bare;
}

const KIT_README = `# Kit

This team's event-hog kit: design systems (brand/<name>/DESIGN.md, written by save_design_system) and per-person settings (config/skills.json, written by set_my_research_tools). Skills and the event template ship with the server.
`;

// A team's kit repo appears on its first write; until then reads see an empty kit.
async function startKit(env: Env): Promise<void> {
  const files: Record<string, string> = { "README.md": KIT_README };
  for (const [p, text] of Object.entries(KIT)) if (p.startsWith("brand/") || p.startsWith("config/")) files[p] = text;
  try {
    await createRepo(env, env.KIT_REPO, "event-hog kit", files, { name: "event-hog", email: "kit@eventhog.invalid" }, "kit: start from the bundled kit");
  } catch (err) {
    // A teammate's first write may have started it a moment ago.
    console.warn(JSON.stringify({ msg: "kit not created", repo: env.KIT_REPO, error: String(err) }));
  }
}

/** Create a repo and push its first commit; deletes it again if the push fails. Returns the commit id. */
export async function createRepo(
  env: Env,
  name: string,
  description: string,
  files: Record<string, string>,
  author: { name: string; email: string },
  message: string,
): Promise<string> {
  const created = await env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" });
  try {
    const fs = new MemoryFS();
    await git.init({ fs, dir: DIR, defaultBranch: "main" });
    for (const [p, text] of Object.entries(files)) {
      await fs.promises.mkdir(`${DIR}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true } as any).catch(() => {});
      await fs.promises.writeFile(`${DIR}/${p}`, text);
      await git.add({ fs, dir: DIR, filepath: p });
    }
    const oid = await git.commit({ fs, dir: DIR, message, author });
    const secret = String(created.token).split("?expires=")[0];
    const pushed: any = await git.push({ fs, http, dir: DIR, url: created.remote, ref: "main", onAuth: () => ({ username: "x", password: secret }) });
    if (pushed?.ok === false) throw new Error(pushed?.error ?? "push rejected");
    return oid;
  } catch (err) {
    // Don't leave an empty repo behind for the next try to trip on.
    await env.ARTIFACTS.delete(name).catch(() => {});
    throw err;
  }
}

export async function open(env: Env, event: string, scope: "read" | "write", space: Space = "event"): Promise<Workspace> {
  const ns = space === "brain" ? env.BRAIN_NAMESPACE : env.NAMESPACE;
  const name = space === "brain" ? event : repoFor(env, event);
  let repo: any;
  try {
    repo = await (space === "brain" ? env.BRAIN : env.ARTIFACTS).get(name);
  } catch (err: any) {
    if (space === "brain" || (name === env.KIT_REPO && !env.TEAM_ID)) throw err;
    if (name !== env.KIT_REPO) throw new Error(noEvent(event));
    if (scope === "read") return { fs: new MemoryFS(), remote: "", onAuth: () => ({ username: "x", password: "" }) };
    await startKit(env);
    repo = await env.ARTIFACTS.get(name);
  }
  try {
    const info = await repo.info();
    const remote: string =
      info?.remote ?? `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${ns}/${name}.git`;
    const token = await repo.createToken(scope, 600);
    const secret = String(token.plaintext).split("?expires=")[0];
    const onAuth = () => ({ username: "x", password: secret });
    const fs = new MemoryFS();
    await git.clone({ fs, http, dir: DIR, url: remote, ref: "main", singleBranch: true, onAuth });
    return { fs, remote, onAuth };
  } finally {
    repo?.[Symbol.dispose]?.();
  }
}

export async function read(ws: Workspace, path: string): Promise<string | null> {
  try {
    return (await ws.fs.promises.readFile(`${DIR}/${clean(path)}`, "utf8")) as string;
  } catch {
    return null;
  }
}

export async function walk(ws: Workspace, dir = ""): Promise<string[]> {
  const base = dir ? `${DIR}/${dir}` : DIR;
  let names: string[];
  try {
    names = await ws.fs.promises.readdir(base);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name === ".git") continue;
    const rel = dir ? `${dir}/${name}` : name;
    const stat = await ws.fs.promises.stat(`${DIR}/${rel}`);
    if (stat.isDirectory()) out.push(...(await walk(ws, rel)));
    else out.push(rel);
  }
  return out;
}

// Clone, apply `change`, commit as `person`, push. Retries from a fresh clone when
// a teammate's push lands first. `change` writes files and returns the paths it
// touched plus a summary for the caller.
export async function write(
  env: Env,
  event: string,
  person: Person,
  message: string,
  change: (ws: Workspace) => Promise<{ paths: string[]; summary: string }>,
  // Runs only after the push lands, so git stays the record; a failure here is
  // reported, not retried, and never undoes the commit.
  after?: (oid: string) => Promise<string>,
  space: Space = "event",
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ws = await open(env, event, "write", space);
    const { paths, summary } = await change(ws);
    for (const filepath of paths) await git.add({ fs: ws.fs, dir: DIR, filepath });
    const oid = await git.commit({
      fs: ws.fs,
      dir: DIR,
      message,
      author: { name: person.name, email: person.email },
    });
    try {
      const result: any = await git.push({ fs: ws.fs, http, dir: DIR, url: ws.remote, ref: "main", onAuth: ws.onAuth });
      if (result?.ok === false) throw new Error(result?.error ?? "push rejected");
      const saved = `${summary}\n\nSaved as commit ${oid.slice(0, 8)} by ${person.name}.`;
      if (!after) return saved;
      try {
        return `${saved}\n${await after(oid)}`;
      } catch (err: any) {
        return `${saved}\nThe agnostic-crm database didn't take it (${err?.message ?? err}). The git record is safe.`;
      }
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1) + Math.random() * 200));
    }
  }
  throw new Error(`Couldn't save after several tries (a teammate may be writing at the same moment): ${String(lastError)}`);
}

// ---------------------------------------------------------------- helpers

function clean(path: string): string {
  const p = String(path ?? "").replace(/^\/+/, "");
  if (!p || p.split("/").some((s) => s === ".." || s === ".git")) throw new Error(`Invalid path: ${path}`);
  return p;
}

export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function slug(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function now(env: Env): { stamp: string; date: string; iso: string; zone: string } {
  const d = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.EVENT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, stamp: `${date} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`, iso: d.toISOString(), zone: parts.timeZoneName };
}

export type Front = Record<string, string>;

export function parseFront(text: string): { front: Front; order: string[]; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { front: {}, order: [], body: text };
  const front: Front = {};
  const order: string[] = [];
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    front[kv[1]] = v;
    order.push(kv[1]);
  }
  return { front, order, body: text.slice(m[0].length) };
}

export function renderFront(front: Front, order: string[]): string {
  const keys = [...order, ...Object.keys(front).filter((k) => !order.includes(k))];
  const lines = keys.map((k) => `${k}: ${front[k] ? JSON.stringify(front[k]) : ""}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

const CONTACT_FIELDS = ["name", "company", "title", "email", "phone", "linkedin", "priority"] as const;

// Contacts__Met.csv: everyone the team met and logged at this event, one row
// each, regenerated from contacts/*.md on every log_contact and
// mark_crm_synced. The .md files are the record; the CSV is a view of them
// for spreadsheets and imports, so hand edits to it are overwritten.
// (Attendee lists are reference material and live in prep/, not here.)
export const CONTACTS_CSV = "Contacts__Met.csv";
const CONTACTS_COLUMNS = [
  "Name", "Company", "Title", "Email", "Phone", "LinkedIn", "Priority",
  "First Logged By", "First Logged By Email", "First Logged At", "Touchpoints", "Last Touchpoint",
  "Latest Follow-Up", "HubSpot Status", "HubSpot ID", "File",
];

// E.164 when a number is unambiguous (US/Canada 10 digits, or already
// international); otherwise left as written rather than guessed. A field with
// several numbers ("… (mobile); … x12 (office)") gets each one normalized in
// place, labels and extensions kept.
function e164One(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (s.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return s;
}
function e164(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const parts = s.match(/\+?\(?\d[\d\s().-]{6,}\d/g) ?? [];
  if (parts.length <= 1 && !/x\s*\d|ext/i.test(s) && !/[a-z]{3,}/i.test(s)) return e164One(s);
  return s.replace(/\+?\(?\d[\d\s().-]{6,}\d/g, (m) => e164One(m));
}

async function refreshContactsCsv(ws: Workspace): Promise<{ path: string; rows: number; csv: string }> {
  const lines = [CONTACTS_COLUMNS.join(",")];
  const files = (await walk(ws, "contacts")).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const text = (await read(ws, f)) ?? "";
    const { front, body } = parseFront(text);
    const touches = [...body.matchAll(/^### (.+?) · (.+)$/gm)];
    const followUps = [...body.matchAll(/^- \*\*Follow-up:\*\* (.+)$/gm)];
    const last = touches.at(-1);
    lines.push(
      [
        front.name, front.company, front.title, front.email, e164(front.phone), front.linkedin, front.priority,
        front.first_logged_by, front.first_logged_by_email, front.first_logged_at,
        touches.length, last ? `${last[1]} (${last[2]})` : "", followUps.at(-1)?.[1] ?? "",
        front.hubspot_status || "pending", front.hubspot_id, f,
      ].map(csvCell).join(","),
    );
  }
  const csv = lines.join("\n") + "\n";
  await ws.fs.promises.writeFile(`${DIR}/${CONTACTS_CSV}`, csv);
  return { path: CONTACTS_CSV, rows: files.length, csv };
}

// ---------------------------------------------------------------- who met whom

type Logger = { name: string; email: string };
const PLACEHOLDER_EMAIL = /@eventhog\.invalid$/i;
const sameLogger = (a: Logger, b: Logger) =>
  (!!a.email && !!b.email && a.email === b.email) || (!!a.name && a.name.toLowerCase() === b.name.toLowerCase());

// Everyone who logged a touchpoint with each contact at this event: the
// database's interactions (name and CRM email per touchpoint), the file's
// first logger, and the file's touchpoint headings (names only).
async function contactLoggers(env: Env, event: string, ws: Workspace): Promise<{ files: string[]; byFile: Map<string, Logger[]> }> {
  const byFile = new Map<string, Logger[]>();
  const add = (f: string, l: Logger) => {
    if (!l.name && !l.email) return;
    const list = byFile.get(f) ?? [];
    const known = list.find((x) => sameLogger(x, l));
    if (!known) list.push(l);
    else if (!known.email && l.email) known.email = l.email;
    byFile.set(f, list);
  };
  try {
    const { results } = await env.CRM.prepare(
      `SELECT i.artifact_path AS path, i.logged_by AS name, i.logged_by_email AS email
         FROM interactions i JOIN event_instances e ON e.id = i.event_instance_id
        WHERE e.slug = ? AND i.artifact_path IS NOT NULL`,
    )
      .bind(event)
      .all();
    for (const r of (results ?? []) as any[]) add(r.path, { name: String(r.name ?? ""), email: String(r.email ?? "").toLowerCase() });
  } catch {
    // The files alone still say who logged what.
  }
  const files = (await walk(ws, "contacts")).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const { front, body } = parseFront((await read(ws, f)) ?? "");
    add(f, { name: String(front.first_logged_by ?? ""), email: String(front.first_logged_by_email ?? "").toLowerCase() });
    for (const m of body.matchAll(/^### (.+?) · (.+)$/gm)) add(f, { name: m[2].trim(), email: "" });
  }
  return { files, byFile };
}

// met_by: names, emails, or "me". Each must pick out exactly one person who
// logged someone at this event, so "Michael" can't silently mean two people.
function metByFilter(wanted: unknown, person: Person, byFile: Map<string, Logger[]>): { keep: (f: string) => boolean; who: Logger[] } | null {
  const asked = (Array.isArray(wanted) ? wanted : wanted ? [wanted] : []).map((w) => String(w).trim()).filter(Boolean);
  if (!asked.length) return null;
  const everyone: Logger[] = [];
  for (const list of byFile.values()) for (const l of list) if (!everyone.some((x) => sameLogger(x, l))) everyone.push(l);
  const roster = () => everyone.map((l) => `${l.name}${l.email && !PLACEHOLDER_EMAIL.test(l.email) ? ` <${l.email}>` : ""}`).join(", ") || "nobody yet";
  const mine = identities(person);
  const who: Logger[] = [];
  for (const w of asked) {
    const q = w.toLowerCase();
    let hits: Logger[];
    if (["me", "mine", "myself"].includes(q)) {
      hits = everyone.filter((l) => mine.includes(l.email) || l.name.toLowerCase() === person.name.toLowerCase());
      if (!hits.length) hits = [{ name: person.name, email: crmEmail(person) }];
    } else if (q.includes("@")) {
      hits = everyone.filter((l) => l.email === q);
    } else {
      hits = everyone.filter((l) => l.name.toLowerCase() === q);
      if (!hits.length) {
        const words = q.split(/\s+/);
        hits = everyone.filter((l) => words.every((wd) => l.name.toLowerCase().split(/\s+/).includes(wd)));
      }
    }
    const distinct = hits.filter((l, i) => hits.findIndex((x) => sameLogger(x, l)) === i);
    if (!distinct.length) throw new Error(`Nobody called "${w}" has logged contacts at this event. People who have: ${roster()}.`);
    if (distinct.length > 1) {
      const names = distinct.map((l) => `${l.name}${l.email && !PLACEHOLDER_EMAIL.test(l.email) ? ` <${l.email}>` : ""}`);
      throw new Error(`"${w}" matches more than one person: ${names.join(", ")}. Use a full name or email.`);
    }
    if (!who.some((x) => sameLogger(x, distinct[0]))) who.push(distinct[0]);
  }
  return { keep: (f) => (byFile.get(f) ?? []).some((l) => who.some((x) => sameLogger(x, l))), who };
}

const metByArgs = {
  met_by: {
    type: "array",
    items: { type: "string" },
    description: 'Only contacts these people met at this event: names, emails, or "me" (e.g. ["me", "Michael"]). Omit for everyone the team met.',
  },
  owner: {
    type: "string",
    description: 'Who owns each contact in the CRM: "met_by" (default: the teammate who first logged them) or "me" (the person calling).',
  },
};

function ownerFor(front: Front, owner: unknown, person: Person): string {
  return owner === "me" ? crmEmail(person) : String(front.first_logged_by_email ?? "");
}

function ownerLabel(email: string, name?: string): string {
  return email && !PLACEHOLDER_EMAIL.test(email)
    ? `owner: the HubSpot user with email ${email}`
    : `owner: unknown (${name ? `${name} has` : "whoever logged it has"} no work email saved; ask who should own it)`;
}

// ---------------------------------------------------------------- tools

const eventArg = {
  event: { type: "string", description: "Event repo name. Omit for the current event." },
};

const BASE_TOOLS = [
  {
    name: "whoami",
    description: "Who this connector writes as, and which event is current.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_events",
    description: "List every event workspace in event-hog.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "event_brief",
    description:
      "Start here. The event's README, the team, the prep docs available, and counts of contacts and notes logged so far.",
    inputSchema: { type: "object", properties: { ...eventArg } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_files",
    description: "List files in the event workspace, optionally under one folder (e.g. contacts, notes, prep).",
    inputSchema: { type: "object", properties: { dir: { type: "string" }, ...eventArg } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Read one file from the event workspace, e.g. prep/prep-map.md or contacts/jane-doe--acme.md.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...eventArg }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description:
      "Case-insensitive text search across every file in the event workspace. Use it before logging a contact, or to answer 'who has met someone from X?'.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, ...eventArg }, required: ["query"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "recent_activity",
    description: "The latest commits: who logged what, and when.",
    inputSchema: { type: "object", properties: { limit: { type: "number" }, ...eventArg } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "log_contact",
    description:
      "Log a person met at the event, plus this touchpoint. If the contact already exists (same email, else same name and company), the touchpoint is appended and blank fields are filled in; nothing is overwritten. Only include fields the user actually gave you.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        company: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        linkedin: { type: "string" },
        priority: { type: "string", description: "A (pursue now), B (follow up), or C (nice to know)" },
        where_met: { type: "string", description: "Booth, session, dinner, hallway..." },
        notes: { type: "string", description: "What was said, what they care about" },
        follow_up: { type: "string", description: "The next step and who owns it" },
        based_in: { type: "string", description: "Where they're based, in whatever words they used (\"Austin\", \"Central Texas\")" },
        ...eventArg,
      },
      required: ["name", "notes"],
    },
  },
  {
    name: "add_note",
    description: "Add a note that isn't about one person: a session takeaway, a theme from the floor, an idea, a to-do.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", description: "session, theme, idea, todo, or general" },
        ...eventArg,
      },
      required: ["title", "body"],
    },
  },
  {
    name: "append_to_file",
    description:
      "Append a dated, attributed line or paragraph to an existing shared file, e.g. mark a prep-map target as met. Appends only; never rewrites.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, text: { type: "string" }, ...eventArg },
      required: ["path", "text"],
    },
  },
  {
    name: "contacts_csv",
    description: `Rebuild and return ${CONTACTS_CSV}: everyone the team met and logged at this event, one row each (name, company, title, email, phone in E.164, LinkedIn, priority, who logged them and when, touchpoints, latest follow-up, HubSpot status). It also updates itself on every log_contact. For spreadsheets and imports; not an attendee list.`,
    inputSchema: { type: "object", properties: { ...eventArg } },
  },
  {
    name: "export_hubspot_csv",
    description:
      "Write every contact still pending for HubSpot into a CSV with HubSpot's import column names (Contact owner is the logger's HubSpot email, or the caller's with owner: me), commit it under exports/, and return it. met_by narrows it to the contacts certain teammates met. Use at stopping points when the HubSpot connection isn't working, so the team can bulk-import later. Contacts stay pending until mark_crm_synced.",
    inputSchema: {
      type: "object",
      properties: {
        include_synced: { type: "boolean", description: "Include contacts already in HubSpot (default false)" },
        ...metByArgs,
        ...eventArg,
      },
    },
  },
  {
    name: "crm_queue",
    description:
      'What to put in HubSpot for this event: contacts not yet there (with their fields, everyone who met them, and the owner to use), and conversations not yet logged (each touchpoint to become a HubSpot meeting, and each follow-up a task). Everyone the team met by default; met_by narrows it ("sync the people I met" is met_by ["me"]; "mine and Michael\'s" is ["me", "Michael"]).',
    inputSchema: { type: "object", properties: { ...metByArgs, ...eventArg } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "mark_crm_synced",
    description: "Record that a contact now exists in HubSpot. Call only after the HubSpot record was actually created or found.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The contact file, e.g. contacts/jane-doe--acme.md" },
        hubspot_id: { type: "string" },
        hubspot_url: { type: "string" },
        ...eventArg,
      },
      required: ["path", "hubspot_id"],
    },
  },
  {
    name: "mark_touchpoints_synced",
    description:
      "Record that conversations from crm_queue are now in HubSpot: each touchpoint's meeting (or note, if meetings couldn't be created) and, if it had a follow-up, its task. Call only after HubSpot returned the IDs. Keeps the next crm_queue from proposing them again.",
    inputSchema: {
      type: "object",
      properties: {
        touchpoints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The touchpoint id from crm_queue" },
              activity_id: { type: "string", description: "The HubSpot meeting (or note) ID" },
              task_id: { type: "string", description: "The HubSpot task ID for its follow-up, if one was created" },
            },
            required: ["id", "activity_id"],
          },
        },
        ...eventArg,
      },
      required: ["touchpoints"],
    },
  },
];

const TOOLS = [...ONBOARDING_TOOLS, ...SUGGESTION_TOOLS, ...ENRICH_TOOLS, ...BASE_TOOLS, ...CRM_TOOLS, ...LOCATION_TOOLS, ...SKILL_TOOLS, ...STARTER_TOOLS, ...SLIDE_TOOLS, ...BRAND_TOOLS, ...EVENT_TOOLS, ...UPLOAD_TOOLS, ...TEAM_TOOLS];

// Most tools answer in text; a few (view_slide) return MCP content blocks, e.g. an image.
export type Handler = (args: any, env: Env, person: Person) => Promise<string | { content: any[] }>;

const ev = (args: any, env: Env) => (args?.event ? String(args.event) : env.DEFAULT_EVENT);

const HANDLERS: Record<string, Handler> = {
  ...ONBOARDING_HANDLERS,
  ...ENRICH_HANDLERS,
  ...SUGGESTION_HANDLERS,
  ...CRM_HANDLERS,
  ...LOCATION_HANDLERS,
  ...SKILL_HANDLERS,
  ...STARTER_HANDLERS,
  ...SLIDE_HANDLERS,
  ...BRAND_HANDLERS,
  ...EVENT_HANDLERS,
  ...UPLOAD_HANDLERS,
  ...TEAM_HANDLERS,
  async whoami(_args, env, person) {
    const [primary, ...others] = identities(person);
    const also = others.length ? ` Also known as: ${others.join(", ")}.` : "";
    const company = person.company ? ` You represent ${person.company}.` : "";
    const admin = person.admin === true ? " You're an admin: you can add and remove teammates (add_person, remove_person)." : "";
    const guest = person.guest ? " This connector has no name yet: run get_started." : "";
    const event = env.DEFAULT_EVENT ? `Current event: ${env.DEFAULT_EVENT}.` : "No events yet: get_started finds or starts one.";
    return `You are ${person.name} <${primary}> (commits are authored as this address).${also}${company} You're in ${teamName(env, person)}: everyone on it shares its events and contacts, and nobody outside it can see them. HubSpot knows you as ${crmEmail(person)}. ${event}${admin}${guest}`;
  },

  async list_events(_args, env) {
    const known = new Map(((await eventsTable(env)) ?? []).map((i) => [i.slug, i]));
    // A team's events are the ones in its own database. Home lists the
    // namespace, minus the kit and other teams' tm- repos.
    const names: string[] = env.TEAM_ID ? [...known.keys()] : [];
    for (let i = 0, cursor: string | undefined; !env.TEAM_ID && i < 20; i++) {
      const page = await env.ARTIFACTS.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      names.push(...(page?.repos ?? []).map((r: any) => String(r.name)).filter((n: string) => n !== env.KIT_REPO && !n.startsWith("tm-")));
      cursor = page?.cursor;
      if (!cursor) break;
    }
    const line = (n: string) => {
      const i = known.get(n);
      const when = i?.starts_on ? ` · ${i.starts_on}${i.ends_on && i.ends_on !== i.starts_on ? ` to ${i.ends_on}` : ""}` : "";
      return `- ${n}${i && i.name !== n ? ` · ${i.name}` : ""}${when}${n === env.DEFAULT_EVENT ? " (current)" : ""}`;
    };
    return names.length ? `${names.map(line).join("\n")}\n\nThe current event is the one on today, else one that ended in the last week, else the next one. new_event starts another.` : "No events yet. new_event starts one.";
  },

  async event_brief(args, env, person) {
    const ws = await open(env, ev(args, env), "read");
    const files = await walk(ws);
    const readme = (await read(ws, "README.md")) ?? "(no README.md)";
    const count = (dir: string) => files.filter((f) => f.startsWith(`${dir}/`) && f.endsWith(".md")).length;
    const docs = files.filter((f) => !f.startsWith("contacts/") && !f.startsWith("notes/") && f !== "README.md");
    return [
      readme.trim(),
      "",
      "---",
      `Contacts logged: ${count("contacts")} · Notes: ${count("notes")}`,
      `Other docs:\n${docs.map((d) => `- ${d}`).join("\n") || "- (none)"}`,
      `You're writing as ${person.name}.`,
    ].join("\n");
  },

  async list_files(args, env) {
    const ws = await open(env, ev(args, env), "read");
    const dir = args?.dir ? clean(args.dir).replace(/\/+$/, "") : "";
    const files = await walk(ws, dir);
    return files.length ? files.map((f) => `- ${f}`).join("\n") : "No files there.";
  },

  async read_file(args, env) {
    const ws = await open(env, ev(args, env), "read");
    const text = await read(ws, args.path);
    if (text === null) throw new Error(`No file at ${args.path}. Try list_files.`);
    return text;
  },

  async search(args, env) {
    const q = String(args.query ?? "").toLowerCase().trim();
    if (!q) throw new Error("Give a search query.");
    const ws = await open(env, ev(args, env), "read");
    const hits: string[] = [];
    for (const f of await walk(ws)) {
      const text = (await read(ws, f)) ?? "";
      text.split("\n").forEach((line, i) => {
        if (hits.length < 60 && line.toLowerCase().includes(q)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
    return hits.length ? hits.join("\n") : `Nothing matches "${args.query}".`;
  },

  async recent_activity(args, env) {
    const ws = await open(env, ev(args, env), "read");
    const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 50);
    const log = await git.log({ fs: ws.fs, dir: DIR, depth: limit });
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: env.EVENT_TIMEZONE,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    return log
      .map((c: any) => `- ${fmt.format(new Date(c.commit.author.timestamp * 1000))} · ${c.commit.author.name} · ${c.commit.message.trim().split("\n")[0]}`)
      .join("\n");
  },

  async log_contact(args, env, person) {
    if (!args?.name || !args?.notes) throw new Error("A contact needs at least a name and notes.");
    const email = String(args.email ?? "").trim().toLowerCase();
    const teammate = email ? (await allPeople(env)).find((p) => identities(p).includes(email)) : undefined;
    if (teammate) throw new Error(`${email} is ${teammate.name}, a teammate on this workspace, not a contact. Use add_note for team notes.`);
    const event = ev(args, env);
    const nameSlug = slug(args.name);
    if (!nameSlug) throw new Error("That name has no letters or digits to file it under.");
    const fileName = args.company ? `${nameSlug}--${slug(args.company)}` : nameSlug;
    let created = false;
    let path = "";

    return write(env, event, person, `contact: ${args.name}${args.company ? ` (${args.company})` : ""}`, async (ws) => {
      const t = now(env);
      const existing = await findContact(ws, args, nameSlug, fileName);
      path = existing ?? `contacts/${fileName}.md`;
      created = !existing;

      const touch = [
        `### ${t.stamp} · ${person.name}`,
        args.where_met ? `- **Where:** ${args.where_met}` : null,
        `- **Notes:** ${args.notes}`,
        args.follow_up ? `- **Follow-up:** ${args.follow_up}` : null,
        "",
      ]
        .filter((l) => l !== null)
        .join("\n");

      let text: string;
      if (existing) {
        const parsed = parseFront((await read(ws, existing)) ?? "");
        for (const k of CONTACT_FIELDS) if (args[k] && !parsed.front[k]) parsed.front[k] = String(args[k]);
        text = renderFront(parsed.front, parsed.order) + parsed.body.replace(/\s*$/, "\n\n") + touch;
      } else {
        const front: Front = {};
        for (const k of CONTACT_FIELDS) front[k] = args[k] ? String(args[k]) : "";
        Object.assign(front, {
          event,
          first_logged_by: person.name,
          first_logged_by_email: crmEmail(person),
          first_logged_at: t.iso,
          hubspot_status: "pending",
          hubspot_id: "",
          hubspot_url: "",
        });
        const heading = `# ${args.name}${args.company ? ` · ${args.company}` : ""}${args.title ? `\n\n${args.title}` : ""}`;
        text = `${renderFront(front, Object.keys(front))}\n${heading}\n\n## Touchpoints\n\n${touch}`;
      }
      await ws.fs.promises.writeFile(`${DIR}/${path}`, text);
      await refreshContactsCsv(ws);
      return {
        paths: [path, CONTACTS_CSV],
        summary: `${created ? "New contact" : "Added a touchpoint to existing contact"}: ${path}${created ? "" : " (found by email or name; nothing was overwritten)"}. HubSpot status: pending.`,
      };
    }, (oid) => recordContact(env, person, event, args, path, oid));
  },

  async add_note(args, env, person) {
    if (!args?.title || !args?.body) throw new Error("A note needs a title and a body.");
    const kind = slug(args.kind || "general") || "general";
    return write(env, ev(args, env), person, `note (${kind}): ${args.title}`, async (ws) => {
      const t = now(env);
      const path = `notes/${t.date}_${slug(person.name)}_${slug(args.title) || "note"}-${t.iso.slice(11, 19).replace(/:/g, "")}.md`;
      const front: Front = { title: String(args.title), kind, author: person.name, created_at: t.iso };
      await ws.fs.promises.writeFile(`${DIR}/${path}`, `${renderFront(front, Object.keys(front))}\n# ${args.title}\n\n${String(args.body).trim()}\n`);
      return { paths: [path], summary: `Note saved: ${path}` };
    });
  },

  async append_to_file(args, env, person) {
    const path = clean(args.path);
    return write(env, ev(args, env), person, `update: ${path}`, async (ws) => {
      const current = await read(ws, path);
      if (current === null) throw new Error(`No file at ${path}. append_to_file only adds to existing files.`);
      const t = now(env);
      await ws.fs.promises.writeFile(`${DIR}/${path}`, `${current.replace(/\s*$/, "\n\n")}> ${t.stamp} · ${person.name}: ${String(args.text).trim()}\n`);
      return { paths: [path], summary: `Appended to ${path}.` };
    });
  },

  async export_hubspot_csv(args, env, person) {
    const event = ev(args, env);
    let rows = 0;
    let preview = "";
    return write(env, event, person, "export: HubSpot import CSV", async (ws) => {
      const cols = [
        "Email",
        "First Name",
        "Last Name",
        "Company Name",
        "Job Title",
        "Phone Number",
        "LinkedIn URL",
        "Contact owner",
        "Event",
        "Priority",
        "Event-hog file",
      ];
      const lines = [cols.map(csvCell).join(",")];
      const { files, byFile } = await contactLoggers(env, event, ws);
      const filter = metByFilter(args?.met_by, person, byFile);
      for (const f of files) {
        if (filter && !filter.keep(f)) continue;
        const { front } = parseFront((await read(ws, f)) ?? "");
        if (!args?.include_synced && (front.hubspot_status || "pending") !== "pending") continue;
        // HubSpot imports want first and last name apart. Split on the first
        // space so particles stay with the surname ("Pablo" / "De Luynes");
        // single names go in First Name. Check odd names before importing.
        const name = String(front.name ?? "").trim();
        const cut = name.indexOf(" ");
        const first = cut > 0 ? name.slice(0, cut) : name;
        const last = cut > 0 ? name.slice(cut + 1) : "";
        const owner = ownerFor(front, args?.owner, person);
        lines.push(
          [front.email, first, last, front.company, front.title, front.phone, front.linkedin, PLACEHOLDER_EMAIL.test(owner) ? "" : owner, front.event, front.priority, f]
            .map(csvCell)
            .join(","),
        );
        rows++;
      }
      const whose = filter ? ` met by ${filter.who.map((l) => l.name).join(" or ")}` : "";
      if (!rows) throw new Error(`Nothing pending for HubSpot${whose}, so there's nothing to export.`);
      const t = now(env);
      const path = `exports/hubspot-contacts_${t.date}_${t.iso.slice(11, 16).replace(":", "")}.csv`;
      const csv = lines.join("\n") + "\n";
      preview = lines.slice(0, 6).join("\n");
      await ws.fs.promises.writeFile(`${DIR}/${path}`, csv);
      return {
        paths: [path],
        summary: `Wrote ${rows} contact(s) to ${path} for a HubSpot import (Contacts object; map "Contact owner" by email, and leave Event, Priority and Event-hog file unmapped or as custom properties). They stay pending until imported and marked synced.\n\n${preview}${rows > 5 ? "\n…" : ""}`,
      };
    });
  },

  async crm_queue(args, env, person) {
    const event = ev(args, env);
    const ws = await open(env, event, "read");
    const { files, byFile } = await contactLoggers(env, event, ws);
    const filter = metByFilter(args?.met_by, person, byFile);
    const rows: string[] = [];
    const contactRef = new Map<string, string>();
    for (const f of files) {
      if (filter && !filter.keep(f)) continue;
      const { front } = parseFront((await read(ws, f)) ?? "");
      const pending = (front.hubspot_status || "pending") === "pending";
      contactRef.set(f, pending ? `${front.name} (${f}; create the contact first)` : `${front.name} (HubSpot contact ${front.hubspot_id})`);
      if (!pending) continue;
      const fields = CONTACT_FIELDS.filter((k) => front[k]).map((k) => `${k}: ${front[k]}`).join(" · ");
      const met = (byFile.get(f) ?? []).map((l) => `${l.name}${l.email && !PLACEHOLDER_EMAIL.test(l.email) ? ` <${l.email}>` : ""}`).join(", ") || "?";
      const owner = ownerFor(front, args?.owner, person);
      rows.push(`- ${f} — ${fields} · met by ${met} · ${ownerLabel(owner)}`);
    }

    // Conversations: one HubSpot meeting per touchpoint, owned by whoever had
    // it; one task per open follow-up, owned like the contact.
    const convos: string[] = [];
    try {
      const inst = await env.CRM.prepare("SELECT name FROM event_instances WHERE slug = ?").bind(event).first();
      const { results } = await env.CRM.prepare(
        `SELECT i.id, i.artifact_path AS path, i.occurred_at, i.logged_by, i.logged_by_email, i.where_met, i.notes, i.follow_up, i.follow_up_done_at,
                (SELECT external_id FROM crm_links WHERE entity_type = 'interaction' AND entity_id = i.id AND system = 'hubspot') AS activity_id,
                (SELECT external_id FROM crm_links WHERE entity_type = 'follow_up' AND entity_id = i.id AND system = 'hubspot') AS task_id
           FROM interactions i JOIN event_instances e ON e.id = i.event_instance_id
          WHERE e.slug = ? ORDER BY i.occurred_at`,
      )
        .bind(event)
        .all();
      for (const r of (results ?? []) as any[]) {
        if (!contactRef.has(r.path)) continue;
        const needsTask = r.follow_up && !r.follow_up_done_at && !r.task_id;
        if (r.activity_id && !needsTask) continue;
        const taskOwner = args?.owner === "me" ? crmEmail(person) : String(r.logged_by_email ?? "");
        const parts = [
          `touchpoint ${r.id}`,
          `with ${contactRef.get(r.path)}`,
          String(r.occurred_at).slice(0, 16).replace("T", " ") + " UTC",
          r.activity_id
            ? `meeting already in HubSpot (${r.activity_id})`
            : `meeting "Met at ${inst?.name ?? event}", ${ownerLabel(String(r.logged_by_email ?? ""), r.logged_by)}`,
          r.where_met ? `where: ${r.where_met}` : null,
          r.notes && !r.activity_id ? `notes: ${r.notes}` : null,
          needsTask ? `TASK: "${r.follow_up}", ${ownerLabel(taskOwner)}` : null,
        ].filter(Boolean);
        convos.push(`- ${parts.join(" · ")}`);
      }
    } catch {
      // No database: contacts can still be synced from the files.
    }

    const whose = filter ? ` met by ${filter.who.map((l) => l.name).join(" or ")}` : "";
    if (!rows.length && !convos.length) return `Nothing${whose} pending for HubSpot.`;
    return [
      rows.length ? `${rows.length} contact(s)${whose} pending for HubSpot:\n${rows.join("\n")}` : `No contacts${whose} pending for HubSpot.`,
      convos.length
        ? `${convos.length} conversation(s) to log in HubSpot. Each becomes a completed meeting (that title, start time as shown, body: where + notes) associated with the contact, plus a task for a follow-up (due date: ask once for all), then mark_touchpoints_synced:\n${convos.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  },

  async mark_touchpoints_synced(args, env, person) {
    const list = (Array.isArray(args?.touchpoints) ? args.touchpoints : []).filter((t: any) => t?.id && t?.activity_id);
    if (!list.length) throw new Error("Give at least one touchpoint with its id and the HubSpot activity_id.");
    const ids = list.map((t: any) => String(t.id));
    const { results } = await env.CRM.prepare(`SELECT id FROM interactions WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    const known = new Set(((results ?? []) as any[]).map((r) => r.id));
    const unknown = ids.filter((id: string) => !known.has(id));
    if (unknown.length) throw new Error(`No touchpoint with id ${unknown.join(", ")}. Use the ids crm_queue shows.`);
    const at = new Date().toISOString();
    const link = (type: string, id: string, ext: string) =>
      env.CRM.prepare(
        `INSERT INTO crm_links (entity_type, entity_id, system, external_id, synced_at, synced_by) VALUES (?, ?, 'hubspot', ?, ?, ?)
         ON CONFLICT (entity_type, entity_id, system) DO UPDATE SET external_id = excluded.external_id, synced_at = excluded.synced_at, synced_by = excluded.synced_by`,
      ).bind(type, id, ext, at, person.name);
    const stmts = list.flatMap((t: any) => [
      link("interaction", String(t.id), String(t.activity_id)),
      ...(t.task_id ? [link("follow_up", String(t.id), String(t.task_id))] : []),
    ]);
    await env.CRM.batch(stmts);
    const tasks = list.filter((t: any) => t.task_id).length;
    return `Recorded ${list.length} conversation(s) as in HubSpot${tasks ? `, with ${tasks} follow-up task(s)` : ""}.`;
  },

  async contacts_csv(args, env, person) {
    let out = { path: CONTACTS_CSV, rows: 0, csv: "" };
    const saved = await write(env, ev(args, env), person, `contacts: rebuild ${CONTACTS_CSV}`, async (ws) => {
      out = await refreshContactsCsv(ws);
      return { paths: [CONTACTS_CSV], summary: `${CONTACTS_CSV}: ${out.rows} contact(s).` };
    });
    return `${saved}\n\n${out.csv}`;
  },

  async mark_crm_synced(args, env, person) {
    const path = clean(args.path);
    if (!path.startsWith("contacts/")) throw new Error("mark_crm_synced only applies to files under contacts/.");
    return write(env, ev(args, env), person, `crm: ${path} -> HubSpot ${args.hubspot_id}`, async (ws) => {
      const text = await read(ws, path);
      if (text === null) throw new Error(`No contact at ${path}.`);
      const parsed = parseFront(text);
      parsed.front.hubspot_status = "synced";
      parsed.front.hubspot_id = String(args.hubspot_id);
      if (args.hubspot_url) parsed.front.hubspot_url = String(args.hubspot_url);
      parsed.front.hubspot_synced_by = person.name;
      await ws.fs.promises.writeFile(`${DIR}/${path}`, renderFront(parsed.front, parsed.order) + parsed.body);
      await refreshContactsCsv(ws);
      return { paths: [path, CONTACTS_CSV], summary: `${path} marked as in HubSpot (${args.hubspot_id}).` };
    }, () => recordCrmLink(env, person, path, String(args.hubspot_id), args.hubspot_url ? String(args.hubspot_url) : null));
  },
};

async function findContact(ws: Workspace, args: any, nameSlug: string, fileName: string): Promise<string | null> {
  const files = (await walk(ws, "contacts")).filter((f) => f.endsWith(".md"));
  const email = String(args.email ?? "").trim().toLowerCase();
  if (email) {
    for (const f of files) {
      const { front } = parseFront((await read(ws, f)) ?? "");
      if (String(front.email ?? "").toLowerCase() === email) return f;
    }
  }
  if (files.includes(`contacts/${fileName}.md`)) return `contacts/${fileName}.md`;
  if (!args.company) {
    const sameName = files.filter((f) => f === `contacts/${nameSlug}.md` || f.startsWith(`contacts/${nameSlug}--`));
    if (sameName.length === 1) return sameName[0];
  }
  return null;
}

// ---------------------------------------------------------------- prompts

const BASE_PROMPTS = [
  {
    name: "log-from-badge",
    description: "Log a contact from a badge or business-card photo.",
    text: "I'm attaching a photo of a badge or business card from someone I just met. Read the name, company, title, and any email, phone, or LinkedIn from it. Search event-hog for them first. Then ask me for one or two lines on what we talked about and any follow-up, and log the contact with log_contact. Don't guess any field the photo doesn't show.",
  },
  {
    name: "daily-brief",
    description: "What the team did today and who to find next.",
    text: "Use event-hog: run event_brief and recent_activity, then read the prep map. Tell me in a short, phone-friendly list: who the team met today and by whom, which A-priority targets from the prep map nobody has met yet, and the follow-ups that are still open.",
  },
  {
    name: "crm-sync",
    description: "Move pending event contacts into HubSpot, with review.",
    text: "First ask me two things in one message, unless I've already said: whose contacts (everyone the team met, just the people I met, or mine plus named teammates), and who should own them in HubSpot (whoever met them, or me). Then run crm_queue in event-hog with met_by (omit it for everyone; \"me\" means me) and owner (\"me\" if I want to own them all). For each pending contact, check HubSpot for an existing contact (by email, then name and company). Set each owner to the HubSpot user with the owner email shown (use search_owners); if it says the owner is unknown, ask me. Show me what you'd do in HubSpot in one review: a table of contacts to create or update (with owner), then the conversations to log as meetings and the follow-up tasks (with owners), and ask once for the tasks' due date. After I approve, create the contacts and call mark_crm_synced for each with the HubSpot ID; then create each meeting (completed, at the time shown, associated with the contact) and task (associated with the contact), and call mark_touchpoints_synced with their IDs. If your HubSpot connector can't create meetings or tasks, tell me and offer notes instead. If HubSpot isn't connected or its calls fail, run export_hubspot_csv instead (same met_by and owner; it carries contacts only) and tell me where the file is.",
  },
];

const PROMPTS = [...ONBOARDING_PROMPTS, ...BASE_PROMPTS, ...SKILL_PROMPTS, ...STARTER_PROMPTS, ...SLIDE_PROMPTS, ...BRAND_PROMPTS];
