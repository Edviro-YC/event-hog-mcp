// Teams: who can use this server, and which team each connector is on.
//
// One Worker hosts many teams. The deployment's own team is "home": its CRM
// data is the CRM database (D1), its event repos are unprefixed, its media
// sits at the bucket root. Every other team runs in its own Durable Object
// (team-do.ts), with its own database, tm-<id>-* repos and teams/<id>/ media.
// A connector reaches exactly one team; nobody sees another team's events.
//
// Who has access is read from, in order:
// - connector_people (D1), written by add_person, and by signups while
//   SELF_SERVE is "teams". Only hashes of keys are kept. team_id says which
//   team (NULL: home); admin = 1 can add and remove teammates; a removed row
//   locks the key out. A connector's profile is kept on its row.
// - PEOPLE, the Worker secret (connector key -> person), home team only. Each
//   entry is copied into connector_people on the first request that sees it,
//   so the secret can be deleted; it still works if one is set again.
// - members rows with self_serve = 1: connectors that joined the home team
//   from the landing page while SELF_SERVE was "open". admin = 1 on such a
//   row (set with wrangler; no tool writes it) makes it an admin. The table
//   also holds profiles saved before connector_people had profile columns.
//
// The registry always lives in the main D1 (accessDb), also inside a team's
// Durable Object, where env.CRM is the team's own database. query_crm refuses
// to read the registry. Upload links are signed with the SHA-256 of the
// connector key, which every source can produce.

import type { Env, Handler, Person } from "./index";
import { people, identities } from "./index";
import { captureToken } from "./slides";

export const TEAM_TABLE = "connector_people";
/** Tables query_crm must not read: who has access, keys as written, and every team's name. */
export const ACCESS_TABLES = [TEAM_TABLE, "members", "teams"];

// Keys the landing page mints in the browser: 24 random bytes as hex.
const SELF_SERVE_KEY = /^[a-f0-9]{48}$/;
// connector_people.added_by for rows that didn't come from add_person.
const SIGNUP = "eventhog.cc signup";
const FROM_SECRET = "the PEOPLE secret";
const MAX_TEAM_PEOPLE = 25;
const DEFAULT_TEAMS_PER_DAY = 50;

/** Whether a fresh landing-page key works: "open" joins the home team, "teams" starts a team of its own. */
export const selfServeOpen = (env: Env) => env.SELF_SERVE === "open" || env.SELF_SERVE === "teams";

/** A key in the landing page's format, which only works while self-serve is on. */
export const looksSelfServe = (key: string) => SELF_SERVE_KEY.test(key);

/** The registry: the main D1, wherever the call runs. */
export const accessDb = (env: Env) => env.ACCESS_DB ?? env.CRM;

/** Thrown when today's quota of new teams is used up. */
export class SignupsPaused extends Error {
  constructor() {
    super("New teams are paused for today on this server. Try again tomorrow, or ask someone whose team already uses event-hog to invite you.");
  }
}

export async function sha256(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function connectorKey(person: Person): string {
  if (!person.key) throw new Error("Couldn't find this connector's key.");
  return person.key;
}

/** "Acme's team", for telling people which team they're in. */
export function teamName(env: Env, person: Person): string {
  if (!person.team) return env.HOME_TEAM_NAME ? `${env.HOME_TEAM_NAME}'s team` : "this server's own team";
  return person.team_name ? `${person.team_name}'s team` : "your own team (it takes your company's name once you run get_started)";
}

type Row = {
  key_hash: string;
  name: string;
  email: string;
  emails: string | null;
  crm_email: string | null;
  added_by: string;
  added_at: string;
  removed_at?: string | null;
  team_id: string | null;
  team_name?: string | null;
  admin: number;
  company: string | null;
  company_url: string | null;
  ideal_customer: string | null;
};

const ROWS = `SELECT c.*, t.name AS team_name FROM ${TEAM_TABLE} c LEFT JOIN teams t ON t.id = c.team_id`;

function fromRow(r: Row): Person {
  const p: Person = {
    name: r.name || `Guest ${r.key_hash.slice(0, 4)}`,
    email: r.email || `guest-${r.key_hash.slice(0, 8)}@eventhog.invalid`,
    via: r.added_by === SIGNUP ? "self-serve" : r.added_by === FROM_SECRET ? "secret" : "added",
    admin: Number(r.admin) === 1,
  };
  if (!r.name) p.guest = true;
  try {
    const emails = JSON.parse(r.emails ?? "[]");
    if (Array.isArray(emails) && emails.length) p.emails = emails.map(String);
  } catch {}
  if (r.crm_email) p.crm_email = r.crm_email;
  Object.assign(p, profile(r));
  if (r.team_id) {
    p.team = r.team_id;
    if (r.team_name) p.team_name = r.team_name;
  }
  return p;
}

export function memberPerson(row: any): Person {
  const key = String(row.key);
  return {
    key,
    name: row.name || `Guest ${key.slice(0, 4)}`,
    email: row.email || `guest-${key.slice(0, 8)}@eventhog.invalid`,
    company: row.company || undefined,
    company_url: row.company_url || undefined,
    ideal_customer: row.ideal_customer || undefined,
    guest: !row.name,
    via: "self-serve",
    admin: Number(row.admin) === 1,
  };
}

function profile(row: any): Partial<Person> {
  const out: Partial<Person> = {};
  if (row?.company) out.company = row.company;
  if (row?.company_url) out.company_url = row.company_url;
  if (row?.ideal_customer) out.ideal_customer = row.ideal_customer;
  return out;
}

// The caller's team's rows (env.TEAM_ID; unset is home). Until migration
// 0011 is applied the query fails: treat that as nobody added.
async function added(env: Env, where = "", ...binds: unknown[]): Promise<Row[]> {
  try {
    const { results } = await accessDb(env)
      .prepare(`${ROWS} WHERE c.removed_at IS NULL AND c.team_id IS ?${where} ORDER BY c.added_at`)
      .bind(env.TEAM_ID ?? null, ...binds)
      .all();
    return (results ?? []) as Row[];
  } catch {
    return [];
  }
}

async function first(env: Env, sql: string, ...binds: unknown[]): Promise<any | null> {
  try {
    return await accessDb(env).prepare(sql).bind(...binds).first();
  } catch {
    return null;
  }
}

async function selfServeMembers(env: Env): Promise<any[]> {
  if (env.TEAM_ID) return [];
  try {
    const { results } = await accessDb(env).prepare("SELECT * FROM members WHERE self_serve = 1 ORDER BY created_at").all();
    return results ?? [];
  } catch {
    return [];
  }
}

// Copy everyone in PEOPLE into connector_people (home team), with any profile
// they saved, so the secret can be deleted. Once per isolate; rows already
// there are left alone.
let peopleImported = false;
async function importPeople(env: Env): Promise<void> {
  const entries = Object.entries(people(env));
  if (peopleImported || !entries.length || env.TEAM_ID) return;
  const db = accessDb(env);
  const at = new Date().toISOString();
  const stmts: any[] = [];
  for (const [key, p] of entries) {
    if (!p?.name || !p?.email) continue;
    const saved = await first(env, "SELECT company, company_url, ideal_customer FROM members WHERE key = ?", key);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO ${TEAM_TABLE} (key_hash, capture_hash, name, email, emails, crm_email, added_by, added_at, admin, company, company_url, ideal_customer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          await sha256(key),
          await sha256(await captureToken(key)),
          p.name,
          String(p.email).trim().toLowerCase(),
          p.emails?.length ? JSON.stringify(p.emails) : null,
          p.crm_email ?? null,
          FROM_SECRET,
          at,
          p.admin === true ? 1 : 0,
          saved?.company ?? null,
          saved?.company_url ?? null,
          saved?.ideal_customer ?? null,
        ),
    );
  }
  try {
    if (stmts.length) await db.batch(stmts);
    peopleImported = true;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "couldn't copy PEOPLE into connector_people", error: String(err) }));
  }
}

// A new team for a fresh landing-page key, with that connector as its founder
// and admin. Two first calls racing on one key end up on the same team.
async function startTeam(env: Env, key: string): Promise<Person | null> {
  const db = accessDb(env);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await first(env, "SELECT count(*) AS n FROM teams WHERE created_at > ?", since);
  if (!recent) return null;
  if (Number(recent.n) >= (Number(env.MAX_NEW_TEAMS_PER_DAY) || DEFAULT_TEAMS_PER_DAY)) throw new SignupsPaused();
  const keyHash = await sha256(key);
  const team = randomHex(5);
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, '', ?)").bind(team, at),
    db
      .prepare(`INSERT OR IGNORE INTO ${TEAM_TABLE} (key_hash, capture_hash, name, email, added_by, added_at, team_id, admin) VALUES (?, ?, '', '', ?, ?, ?, 1)`)
      .bind(keyHash, await sha256(await captureToken(key)), SIGNUP, at, team),
  ]);
  const row: Row | null = await first(env, `${ROWS} WHERE c.key_hash = ?`, keyHash);
  if (row?.team_id !== team) await db.prepare("DELETE FROM teams WHERE id = ?").bind(team).run();
  return row && !row.removed_at ? { ...fromRow(row), key } : null;
}

// connector_people first (a removed row locks the key out), then PEOPLE, then
// a self-serve member. An unknown key in the landing page's format starts a
// new team while SELF_SERVE is "teams", or joins the home team while it's
// "open".
export async function personForKey(env: Env, key: string): Promise<Person | null> {
  await importPeople(env);
  const row: Row | null = await first(env, `${ROWS} WHERE c.key_hash = ?`, await sha256(key));
  if (row?.removed_at) return null;
  if (row && (row.team_id || row.company)) return { ...fromRow(row), key };

  const member = await first(env, "SELECT * FROM members WHERE key = ?", key);
  if (row) return { ...fromRow(row), ...profile(member), key };
  const fromSecret = people(env)[key];
  if (fromSecret) return { ...fromSecret, ...profile(member), key, via: "secret" };
  if (member) return member.self_serve ? memberPerson(member) : null;
  if (!looksSelfServe(key)) return null;
  if (env.SELF_SERVE === "teams") return startTeam(env, key);
  if (env.SELF_SERVE !== "open") return null;
  try {
    await accessDb(env)
      .prepare("INSERT OR IGNORE INTO members (key, capture_token, self_serve, created_at) VALUES (?, ?, 1, ?)")
      .bind(key, await captureToken(key), new Date().toISOString())
      .run();
  } catch {
    return null;
  }
  return memberPerson({ key });
}

export async function personForCaptureToken(env: Env, token: string): Promise<{ keyHash: string; person: Person } | null> {
  const row: Row | null = await first(env, `${ROWS} WHERE c.capture_hash = ?`, await sha256(token));
  if (row) return row.removed_at ? null : { keyHash: row.key_hash, person: fromRow(row) };
  for (const [key, person] of Object.entries(people(env))) {
    if ((await captureToken(key)) === token) return { keyHash: await sha256(key), person: { ...person, via: "secret" } };
  }
  const member = await first(env, "SELECT * FROM members WHERE capture_token = ? AND self_serve = 1", token);
  return member ? { keyHash: await sha256(String(member.key)), person: memberPerson(member) } : null;
}

// PEOPLE entries not yet copied into connector_people (home only).
async function secretOnly(env: Env, rows: Row[]): Promise<Person[]> {
  if (env.TEAM_ID) return [];
  const known = new Set(rows.map((r) => r.key_hash));
  const out: Person[] = [];
  for (const [key, p] of Object.entries(people(env))) if (!known.has(await sha256(key))) out.push({ ...p, via: "secret" });
  return out;
}

/** Everyone on the caller's team: PEOPLE (home only) and connector_people. */
export async function allPeople(env: Env): Promise<Person[]> {
  const rows = await added(env);
  return [...(await secretOnly(env, rows)), ...rows.map(fromRow)];
}

/** Save what someone says about themselves: on their connector_people row, else (PEOPLE or a landing-page member) in members. */
export async function saveProfile(env: Env, person: Person, values: Record<"name" | "email" | "company" | "company_url" | "ideal_customer", string | null>): Promise<void> {
  const key = connectorKey(person);
  const db = accessDb(env);
  const at = new Date().toISOString();
  const row: Row | null = await first(env, `SELECT key_hash, team_id FROM ${TEAM_TABLE} WHERE key_hash = ?`, await sha256(key));
  if (row) {
    await db
      .prepare(
        `UPDATE ${TEAM_TABLE} SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company),
           company_url = COALESCE(?, company_url), ideal_customer = COALESCE(?, ideal_customer) WHERE key_hash = ?`,
      )
      .bind(values.name, values.email?.toLowerCase() ?? null, values.company, values.company_url, values.ideal_customer, row.key_hash)
      .run();
    // A new team takes its founder's company as its name.
    if (row.team_id && values.company) {
      await db.prepare("UPDATE teams SET name = ? WHERE id = ? AND name = ''").bind(values.company, row.team_id).run();
      person.team_name ??= values.company;
    }
    return;
  }
  await db
    .prepare(
      `INSERT INTO members (key, capture_token, name, email, company, company_url, ideal_customer, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         name = COALESCE(excluded.name, members.name), email = COALESCE(excluded.email, members.email),
         company = COALESCE(excluded.company, members.company), company_url = COALESCE(excluded.company_url, members.company_url),
         ideal_customer = COALESCE(excluded.ideal_customer, members.ideal_customer), updated_at = excluded.updated_at`,
    )
    .bind(key, await captureToken(key), values.name, values.email, values.company, values.company_url, values.ideal_customer, at, at)
    .run();
}

const isAdmin = (person: Person) => person.admin === true;

function requireAdmin(person: Person): void {
  if (isAdmin(person)) return;
  throw new Error(
    person.team
      ? `${person.name} can't add or remove teammates: only an admin can, starting with whoever started this team.`
      : `${person.name} can't add or remove teammates: only an admin can (an admin connector in D1, or someone marked "admin": true in the PEOPLE secret; README: Deploy your own).`,
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailList(v: unknown): string[] {
  return (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

function how(r: Row): string {
  const day = r.added_at.slice(0, 10);
  if (r.added_by === SIGNUP) return `started this team from the landing page on ${day}${r.name ? "" : " (never gave a name)"}`;
  if (r.added_by === FROM_SECRET) return `set in the PEOPLE secret (copied to the database on ${day})`;
  return `added by ${r.added_by} on ${day}`;
}

// ---------------------------------------------------------------- tools

export const TEAM_TOOLS = [
  {
    name: "list_people",
    description:
      "Everyone on this connector's team: name, email, whether they're an admin, and how they got access (started the team, added from chat by whom and when, or joined from the landing page). Everyone listed can read and write every event in the team; other teams on the same server can't see any of it. Never shows connector keys.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_person",
    description:
      "Admins only. Give a new teammate access to this team's events: makes them a connector key and returns their personal connector URL, shown this once. They'll be able to read and write every event in the team, including every contact. Confirm the name and email with the person first. Tell them to send the URL to the teammate privately (it works like a password) and that the teammate adds it in Claude as a custom connector.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Their name, as it should appear on commits" },
        email: { type: "string", description: "Their primary email; commits are authored as this" },
        emails: { type: "array", items: { type: "string" }, description: "Other addresses that are this person" },
        crm_email: { type: "string", description: "The address their CRM (HubSpot) knows them by, if different" },
      },
      required: ["name", "email"],
    },
  },
  {
    name: "remove_person",
    description:
      "Admins only. Revoke a teammate's connector by email: their URL stops working at once. Their past commits and contacts stay.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
];

export const TEAM_HANDLERS: Record<string, Handler> = {
  async list_people(_args, env, person) {
    const rows = await added(env);
    const fromSecret = await secretOnly(env, rows);
    const joined = await selfServeMembers(env);
    const line = (p: Person, how: string) => `- ${p.name} <${p.email}>${isAdmin(p) ? " · admin" : ""} · ${how}`;
    const lines = [
      ...fromSecret.map((p) => line(p, "set in PEOPLE")),
      ...rows.map((r) => line(fromRow(r), how(r))),
      ...joined.map((r) => line(memberPerson(r), `joined from the landing page on ${String(r.created_at).slice(0, 10)}${r.name ? "" : " (never gave a name)"}`)),
    ];
    const door = env.TEAM_ID
      ? "Only add_person adds people to this team. Anyone else who signs up from the landing page gets a team of their own, and can't see this one."
      : env.SELF_SERVE === "teams"
        ? "People who sign up from the landing page get teams of their own and can't see this one. Only add_person adds people here."
        : env.SELF_SERVE === "open"
          ? "Anyone who copies the landing page's prompt can still join this team (SELF_SERVE is open)."
          : "Nobody new can join from the landing page: only add_person grants access.";
    const team = teamName(env, person);
    if (!lines.length) return `Nobody is on ${team} yet. ${door}`;
    return `${lines.length} connector(s) are on ${team}, and each can read and write every event in it:\n${lines.join("\n")}\n${door}`;
  },

  async add_person(args, env, person) {
    requireAdmin(person);
    const name = String(args?.name ?? "").trim();
    const email = String(args?.email ?? "").trim().toLowerCase();
    if (!name) throw new Error("Give the teammate's name.");
    if (!EMAIL.test(email)) throw new Error(`"${args?.email ?? ""}" isn't an email address.`);
    const others = emailList(args?.emails).filter((e) => e !== email);
    const crm = String(args?.crm_email ?? "").trim().toLowerCase();
    for (const e of [...others, crm].filter(Boolean)) if (!EMAIL.test(e)) throw new Error(`"${e}" isn't an email address.`);

    const everyone = await allPeople(env);
    if (env.TEAM_ID && everyone.length >= MAX_TEAM_PEOPLE) {
      throw new Error(`A team on this server can have up to ${MAX_TEAM_PEOPLE} connectors, and this one has ${everyone.length}. remove_person frees a place.`);
    }
    const wanted = [email, ...others, crm].filter(Boolean);
    const taken = everyone.find((p) => identities(p).some((e) => wanted.includes(e)));
    if (taken) throw new Error(`${taken.name} <${taken.email}> is already on this team with that address. list_people shows everyone.`);

    const base = env.PUBLIC_URL;
    if (!base) throw new Error("PUBLIC_URL isn't set. Set it in wrangler.jsonc vars to this Worker's public URL and redeploy.");

    const key = randomHex(24);
    try {
      await accessDb(env)
        .prepare(`INSERT INTO ${TEAM_TABLE} (key_hash, capture_hash, name, email, emails, crm_email, added_by, added_at, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(key), await sha256(await captureToken(key)), name, email, others.length ? JSON.stringify(others) : null, crm || null, person.name, new Date().toISOString(), env.TEAM_ID ?? null)
        .run();
    } catch (err: any) {
      if (/no such (table|column)/i.test(String(err?.message ?? err))) {
        throw new Error("This server's database is missing the team tables. Run `npx wrangler d1 migrations apply agnostic-crm --remote`, then try again.");
      }
      throw err;
    }

    const team = teamName(env, person);
    return [
      `${name} <${email}> is now on ${team}. Their connector URL (shown this once; it isn't stored anywhere it can be read back):`,
      `${base}/mcp/${key}`,
      "",
      "Send it to them privately: anyone with it acts as them. They add it in Claude as a custom connector, then ask Claude to run whoami to check it says their name and this team.",
      `If they already use event-hog with a team of their own, they add this as a second connector (for example "event-hog ${person.team_name ?? env.HOME_TEAM_NAME ?? "work"}") or replace their old one. Their own team stays reachable through their old URL; nothing is moved or merged.`,
      `They can read and write every event in ${team}, including every contact. remove_person revokes it.`,
    ].join("\n");
  },

  async remove_person(args, env, person) {
    requireAdmin(person);
    const email = String(args?.email ?? "").trim().toLowerCase();
    const at = new Date().toISOString();
    const rows = await added(env);
    const matching = rows.filter((r) => r.email === email);
    if (matching.length) {
      if (env.TEAM_ID && !rows.some((r) => Number(r.admin) === 1 && r.email !== email)) {
        throw new Error(`${matching[0].name || email} is this team's only admin, so they can't be removed. To close the team, ask whoever runs this server.`);
      }
      await accessDb(env)
        .prepare(`UPDATE ${TEAM_TABLE} SET removed_by = ?, removed_at = ? WHERE email = ? AND removed_at IS NULL AND team_id IS ?`)
        .bind(person.name, at, email, env.TEAM_ID ?? null)
        .run();
      return `${matching[0].name || email} <${email}> no longer has access; their connector URL stops working now. What they logged stays, credited to them.`;
    }
    const inSecret = (await secretOnly(env, rows)).find((p) => identities(p).includes(email));
    if (inSecret) throw new Error(`${inSecret.name} is set in the PEOPLE secret. Remove them there with wrangler (npx wrangler secret put PEOPLE) and redeploy.`);
    // Self-serve members keep their profile row; it just stops granting access.
    const joined = (await selfServeMembers(env)).filter((r) => String(r.email ?? "").trim().toLowerCase() === email);
    if (!joined.length) throw new Error(`Nobody on this team has the email ${email}. list_people shows everyone.`);
    await accessDb(env).prepare("UPDATE members SET self_serve = 0, updated_at = ? WHERE lower(email) = ? AND self_serve = 1").bind(at, email).run();
    return `${joined[0].name ?? email} <${email}> no longer has access: ${joined.length} connector(s) that joined from the landing page stop working now. What they logged stays, credited to them.`;
  },
};
