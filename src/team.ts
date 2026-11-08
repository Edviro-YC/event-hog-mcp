// The team: who can use this connector, read from two places.
//
// - PEOPLE, the Worker secret (connector key -> person), set with wrangler.
//   People marked "admin": true there can add and remove teammates from chat.
// - connector_people in agnostic-crm (D1), written by add_person. A Worker
//   can't change its own secrets, so people added at runtime live here. Only
//   hashes of their keys are kept, and query_crm refuses to read the table.
//
// Upload links are signed with the SHA-256 of the connector key, which both
// sources can produce without the raw key on hand.

import type { Env, Handler, Person } from "./index";
import { people, identities } from "./index";
import { captureToken } from "./slides";

export const TEAM_TABLE = "connector_people";

export async function sha256(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The key a request came in on, kept off the Person object so it can't end up
// in a commit, a file, or a tool's output by accident.
const KEYS = new WeakMap<Person, string>();

export function connectorKey(person: Person): string {
  const key = KEYS.get(person);
  if (!key) throw new Error("Couldn't find this connector's key.");
  return key;
}

type Row = { key_hash: string; name: string; email: string; emails: string | null; crm_email: string | null; added_by: string; added_at: string };

function fromRow(r: Row): Person {
  const p: Person = { name: r.name, email: r.email };
  try {
    const emails = JSON.parse(r.emails ?? "[]");
    if (Array.isArray(emails) && emails.length) p.emails = emails.map(String);
  } catch {}
  if (r.crm_email) p.crm_email = r.crm_email;
  return p;
}

// Until migration 0006 is applied there's no table: treat that as nobody added.
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

export async function personForKey(env: Env, key: string): Promise<Person | null> {
  const fromSecret = people(env)[key];
  const row = fromSecret ? null : (await added(env, " AND key_hash = ?", await sha256(key)))[0];
  const person = fromSecret ? { ...fromSecret } : row ? fromRow(row) : null;
  if (person) KEYS.set(person, key);
  return person;
}

export async function personForCaptureToken(env: Env, token: string): Promise<{ keyHash: string; person: Person } | null> {
  for (const [key, person] of Object.entries(people(env))) {
    if ((await captureToken(key)) === token) return { keyHash: await sha256(key), person };
  }
  const row = (await added(env, " AND capture_hash = ?", await sha256(token)))[0];
  return row ? { keyHash: row.key_hash, person: fromRow(row) } : null;
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
      "Everyone who can use this event-hog connector (the team): name, email, whether they're an admin, and whether they're set in the PEOPLE secret or were added from chat (by whom, when). Everyone listed can read and write every event on this server. Never shows connector keys.",
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
      "Admins only. Revoke the connector of someone added with add_person, by email: their URL stops working at once. Their past commits and contacts stay. People set in the PEOPLE secret are removed with wrangler, not here.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
];

export const TEAM_HANDLERS: Record<string, Handler> = {
  async list_people(_args, env) {
    const fromSecret = Object.values(people(env));
    const rows = await added(env);
    const line = (p: Person, how: string) => `- ${p.name} <${p.email}>${isAdmin(p) ? " · admin" : ""} · ${how}`;
    const lines = [
      ...fromSecret.map((p) => line(p, "set in PEOPLE")),
      ...rows.map((r) => line(fromRow(r), `added by ${r.added_by} on ${r.added_at.slice(0, 10)}`)),
    ];
    if (!lines.length) return "Nobody is set up yet.";
    return `${lines.length} people can use this connector, and each can read and write every event on it:\n${lines.join("\n")}`;
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
    const rows = await added(env, " AND email = ?", email);
    if (!rows.length) throw new Error(`Nobody added from chat has the email ${email}. list_people shows everyone.`);
    await env.CRM.prepare(`UPDATE ${TEAM_TABLE} SET removed_by = ?, removed_at = ? WHERE email = ? AND removed_at IS NULL`)
      .bind(person.name, new Date().toISOString(), email)
      .run();
    return `${rows[0].name} <${email}> no longer has access; their connector URL stops working now. What they logged stays, credited to them.`;
  },
};
