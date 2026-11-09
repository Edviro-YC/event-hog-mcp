// The team: who can use this connector, read from three places.
//
// - PEOPLE, the Worker secret (connector key -> person), set with wrangler.
//   People marked "admin": true there can add and remove teammates from chat.
// - connector_people in agnostic-crm (D1), written by add_person. A Worker
//   can't change its own secrets, so people added at runtime live here. Only
//   hashes of their keys are kept.
// - members rows with self_serve = 1: connectors that joined from the landing
//   page. New ones join only while SELF_SERVE is "open". The same table holds
//   the profile anyone saves with save_my_profile; a profile alone grants
//   nothing, so taking someone out of PEOPLE or connector_people locks them out.
//
// query_crm refuses to read connector_people and members (members holds keys
// as written). Upload links are signed with the SHA-256 of the connector key,
// which every source can produce.

import type { Env, Handler, Person } from "./index";
import { people, identities } from "./index";
import { captureToken } from "./slides";

export const TEAM_TABLE = "connector_people";
/** Tables query_crm must not read: who has access, and keys as written. */
export const ACCESS_TABLES = [TEAM_TABLE, "members"];

// Keys the landing page mints in the browser: 24 random bytes as hex.
const SELF_SERVE_KEY = /^[a-f0-9]{48}$/;

export const selfServeOpen = (env: Env) => env.SELF_SERVE === "open";

/** A key in the landing page's format, which only works while self-serve is open. */
export const looksSelfServe = (key: string) => SELF_SERVE_KEY.test(key);

export async function sha256(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function connectorKey(person: Person): string {
  if (!person.key) throw new Error("Couldn't find this connector's key.");
  return person.key;
}

type Row = { key_hash: string; name: string; email: string; emails: string | null; crm_email: string | null; added_by: string; added_at: string; removed_at?: string | null };

function fromRow(r: Row): Person {
  const p: Person = { name: r.name, email: r.email, via: "added" };
  try {
    const emails = JSON.parse(r.emails ?? "[]");
    if (Array.isArray(emails) && emails.length) p.emails = emails.map(String);
  } catch {}
  if (r.crm_email) p.crm_email = r.crm_email;
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
  };
}

// The profile fields a members row adds to someone from PEOPLE or connector_people.
function profile(row: any): Partial<Person> {
  const out: Partial<Person> = {};
  if (row?.company) out.company = row.company;
  if (row?.company_url) out.company_url = row.company_url;
  if (row?.ideal_customer) out.ideal_customer = row.ideal_customer;
  return out;
}

// Until migration 0008 is applied there's no table: treat that as nobody added.
async function added(env: Env, where = "", ...binds: unknown[]): Promise<Row[]> {
  try {
    const { results } = await env.CRM.prepare(
      `SELECT key_hash, name, email, emails, crm_email, added_by, added_at FROM ${TEAM_TABLE} WHERE removed_at IS NULL${where} ORDER BY added_at`,
    )
      .bind(...binds)
      .all();
    return (results ?? []) as Row[];
  } catch {
    return [];
  }
}

async function first(env: Env, sql: string, ...binds: unknown[]): Promise<any | null> {
  try {
    return await env.CRM.prepare(sql).bind(...binds).first();
  } catch {
    return null;
  }
}

async function selfServeMembers(env: Env): Promise<any[]> {
  try {
    const { results } = await env.CRM.prepare("SELECT * FROM members WHERE self_serve = 1 ORDER BY created_at").all();
    return results ?? [];
  } catch {
    return [];
  }
}

// PEOPLE first, then connector_people (a removed row locks the key out), then
// a self-serve member. An unknown key in the landing page's format becomes a
// new member only while SELF_SERVE is "open".
export async function personForKey(env: Env, key: string): Promise<Person | null> {
  const row = await first(env, "SELECT * FROM members WHERE key = ?", key);
  const fromSecret = people(env)[key];
  if (fromSecret) return { ...fromSecret, ...profile(row), key, via: "secret" };

  const addedRow: Row | null = await first(env, `SELECT * FROM ${TEAM_TABLE} WHERE key_hash = ?`, await sha256(key));
  if (addedRow) return addedRow.removed_at ? null : { ...fromRow(addedRow), ...profile(row), key };

  if (row) return row.self_serve ? memberPerson(row) : null;
  if (!selfServeOpen(env) || !looksSelfServe(key)) return null;
  try {
    await env.CRM.prepare("INSERT OR IGNORE INTO members (key, capture_token, self_serve, created_at) VALUES (?, ?, 1, ?)")
      .bind(key, await captureToken(key), new Date().toISOString())
      .run();
  } catch {
    return null;
  }
  return memberPerson({ key });
}

export async function personForCaptureToken(env: Env, token: string): Promise<{ keyHash: string; person: Person } | null> {
  for (const [key, person] of Object.entries(people(env))) {
    if ((await captureToken(key)) === token) return { keyHash: await sha256(key), person: { ...person, via: "secret" } };
  }
  const row = (await added(env, " AND capture_hash = ?", await sha256(token)))[0];
  if (row) return { keyHash: row.key_hash, person: fromRow(row) };
  const member = await first(env, "SELECT * FROM members WHERE capture_token = ? AND self_serve = 1", token);
  return member ? { keyHash: await sha256(String(member.key)), person: memberPerson(member) } : null;
}

/** Everyone who can use this connector: PEOPLE first, then people added from chat. */
export async function allPeople(env: Env): Promise<Person[]> {
  return [...Object.values(people(env)), ...(await added(env)).map(fromRow)];
}

const isAdmin = (person: Person) => person.admin === true;

function requireAdmin(person: Person): void {
  if (!isAdmin(person)) {
    throw new Error(`${person.name} can't add or remove teammates. Someone marked "admin": true in the PEOPLE secret can, or anyone can with wrangler (README: Deploy your own).`);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailList(v: unknown): string[] {
  return (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------- tools

export const TEAM_TOOLS = [
  {
    name: "list_people",
    description:
      "Everyone who can use this event-hog connector (the team): name, email, whether they're an admin, and whether they're set in the PEOPLE secret, were added from chat (by whom, when), or joined from the landing page. Also says whether new people can still join from the landing page. Everyone listed can read and write every event on this server. Never shows connector keys.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_person",
    description:
      "Admins only. Give a new teammate access to this event-hog server: makes them a connector key and returns their personal connector URL, shown this once. They'll be able to read and write every event here, including every contact. Confirm the name and email with the person first. Tell them to send the URL to the teammate privately (it works like a password) and that the teammate adds it in Claude as a custom connector.",
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
      "Admins only. Revoke the connector of someone added with add_person, or who joined from the landing page, by email: their URL stops working at once. Their past commits and contacts stay. People set in the PEOPLE secret are removed with wrangler, not here.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
];

export const TEAM_HANDLERS: Record<string, Handler> = {
  async list_people(_args, env) {
    const fromSecret = Object.values(people(env));
    const rows = await added(env);
    const joined = await selfServeMembers(env);
    const line = (p: Person, how: string) => `- ${p.name} <${p.email}>${isAdmin(p) ? " · admin" : ""} · ${how}`;
    const lines = [
      ...fromSecret.map((p) => line(p, "set in PEOPLE")),
      ...rows.map((r) => line(fromRow(r), `added by ${r.added_by} on ${r.added_at.slice(0, 10)}`)),
      ...joined.map((r) => line(memberPerson(r), `joined from the landing page on ${String(r.created_at).slice(0, 10)}${r.name ? "" : " (never gave a name)"}`)),
    ];
    const door = selfServeOpen(env)
      ? "Anyone who copies the landing page's prompt can still join (SELF_SERVE is open)."
      : "Nobody new can join from the landing page: only PEOPLE and add_person grant access.";
    if (!lines.length) return `Nobody is set up yet. ${door}`;
    return `${lines.length} connector(s) can use this server, and each can read and write every event on it:\n${lines.join("\n")}\n${door}`;
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

    const wanted = [email, ...others, crm].filter(Boolean);
    const taken = (await allPeople(env)).find((p) => identities(p).some((e) => wanted.includes(e)));
    if (taken) throw new Error(`${taken.name} <${taken.email}> already has access with that address. list_people shows everyone.`);

    const base = env.PUBLIC_URL;
    if (!base) throw new Error("PUBLIC_URL isn't set. Set it in wrangler.jsonc vars to this Worker's public URL and redeploy.");

    const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      await env.CRM.prepare(
        `INSERT INTO ${TEAM_TABLE} (key_hash, capture_hash, name, email, emails, crm_email, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(await sha256(key), await sha256(await captureToken(key)), name, email, others.length ? JSON.stringify(others) : null, crm || null, person.name, new Date().toISOString())
        .run();
    } catch (err: any) {
      if (/no such table/i.test(String(err?.message ?? err))) {
        throw new Error("This server's database doesn't have the team table yet. Run `npx wrangler d1 migrations apply agnostic-crm --remote`, then try again.");
      }
      throw err;
    }

    return [
      `${name} <${email}> can now use event-hog, as themselves. Their connector URL (shown this once; it isn't stored anywhere it can be read back):`,
      `${base}/mcp/${key}`,
      "",
      "Send it to them privately: anyone with it acts as them. They add it in Claude as a custom connector, then ask Claude to run whoami to check it says their name.",
      "They can read and write every event on this server, including every contact. remove_person revokes it.",
    ].join("\n");
  },

  async remove_person(args, env, person) {
    requireAdmin(person);
    const email = String(args?.email ?? "").trim().toLowerCase();
    const inSecret = Object.values(people(env)).find((p) => identities(p).includes(email));
    if (inSecret) throw new Error(`${inSecret.name} is set in the PEOPLE secret. Remove them there with wrangler (npx wrangler secret put PEOPLE) and redeploy.`);
    const at = new Date().toISOString();
    const rows = await added(env, " AND email = ?", email);
    if (rows.length) {
      await env.CRM.prepare(`UPDATE ${TEAM_TABLE} SET removed_by = ?, removed_at = ? WHERE email = ? AND removed_at IS NULL`)
        .bind(person.name, at, email)
        .run();
      return `${rows[0].name} <${email}> no longer has access; their connector URL stops working now. What they logged stays, credited to them.`;
    }
    // Self-serve members keep their profile row; it just stops granting access.
    const joined = (await selfServeMembers(env)).filter((r) => String(r.email ?? "").trim().toLowerCase() === email);
    if (!joined.length) throw new Error(`Nobody added from chat or joined from the landing page has the email ${email}. list_people shows everyone.`);
    await env.CRM.prepare("UPDATE members SET self_serve = 0, updated_at = ? WHERE lower(email) = ? AND self_serve = 1").bind(at, email).run();
    return `${joined[0].name ?? email} <${email}> no longer has access: ${joined.length} connector(s) that joined from the landing page stop working now. What they logged stays, credited to them.`;
  },
};
