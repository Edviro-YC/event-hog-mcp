// Getting someone going: get_started asks the two questions (which company,
// which conference), works out whether they're before, during or after it,
// and hands the agent that phase's playbook. Plus the prep tools the
// "before" playbook needs: the attendee roster, the ranked targets, and
// "who should I find next?".

import type { Env, Handler, Person } from "./index";
import { DIR, read, write, slug, now } from "./index";
import { captureToken } from "./slides";
import { ensureInstance, ensureOrg, findPerson } from "./crm";

const ev = (args: any, env: Env) => (args?.event ? String(args.event) : env.DEFAULT_EVENT);
const DAY = 86_400_000;
const PRIORITIES = ["A", "B", "C"];
const ROLES = ["buyer", "champion", "partner", "referral"];
// Each target costs a handful of D1 queries; keep one call well inside the per-request limit.
const MAX_TARGETS = 25;
const FOLLOW_UP_LIMIT = 25;

// ---------------------------------------------------------------- profile

const PROFILE_FIELDS = ["name", "email", "company", "company_url", "ideal_customer"] as const;

async function saveProfile(env: Env, person: Person, args: any): Promise<string[]> {
  if (!person.key) throw new Error("This connector has no key to save a profile under.");
  const values = PROFILE_FIELDS.map((k) => (args?.[k] ? String(args[k]).trim() : null));
  if (values[1] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[1])) throw new Error(`"${values[1]}" isn't an email address.`);
  const changed = PROFILE_FIELDS.filter((_, i) => values[i]);
  if (!changed.length) return [];
  const at = new Date().toISOString();
  await env.CRM.prepare(
    `INSERT INTO members (key, capture_token, name, email, company, company_url, ideal_customer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       name = COALESCE(excluded.name, members.name), email = COALESCE(excluded.email, members.email),
       company = COALESCE(excluded.company, members.company), company_url = COALESCE(excluded.company_url, members.company_url),
       ideal_customer = COALESCE(excluded.ideal_customer, members.ideal_customer), updated_at = excluded.updated_at`,
  )
    .bind(person.key, await captureToken(person.key), ...values, at, at)
    .run();
  for (const [i, k] of PROFILE_FIELDS.entries()) if (values[i]) (person as any)[k] = values[i];
  if (values[0]) person.guest = false;
  return [...changed];
}

// ---------------------------------------------------------------- events

type Instance = { id: string; slug: string; name: string; starts_on: string | null; ends_on: string | null; time_zone: string | null; website: string | null; city: string | null };

const STOP = new Set(["the", "a", "an", "and", "of", "conference", "conferences", "annual", "event", "summit"]);

// Match what the person typed (a name, a slug, or the event's website) to an
// event that already has a workspace. A year they name has to match.
function matchEvents(list: Instance[], q: string): { i: Instance; score: number }[] {
  const raw = q.trim();
  let host = "";
  if (/^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw)) {
    try {
      host = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    } catch {}
  }
  const words = slug(raw).split("-").filter((w) => w && !STOP.has(w));
  const years = words.filter((w) => /^(19|20)\d{2}$/.test(w));
  return list
    .map((i) => {
      if (i.slug === raw) return { i, score: 3 };
      if (host && i.website && i.website.toLowerCase().includes(host)) return { i, score: 2 };
      const hay = new Set(slug(`${i.name} ${i.slug}`).split("-"));
      if (years.some((y) => !hay.has(y))) return { i, score: 0 };
      const score = words.length ? words.filter((w) => hay.has(w)).length / words.length : 0;
      return { i, score };
    })
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
}

export function todayIn(zone: string | null, fallback: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone || fallback }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export type Phase = "before" | "during" | "after";

export function guessPhase(i: Pick<Instance, "starts_on" | "ends_on">, today: string): Phase | null {
  if (!i.starts_on) return null;
  const end = i.ends_on || i.starts_on;
  if (today < i.starts_on) return "before";
  if (today <= end) return "during";
  return "after";
}

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const dates = (i: Instance) => (i.starts_on ? `${i.starts_on}${i.ends_on && i.ends_on !== i.starts_on ? ` to ${i.ends_on}` : ""}` : "dates unknown");

// ---------------------------------------------------------------- playbooks

async function targetCount(env: Env, instanceId: string): Promise<number> {
  const row = await env.CRM.prepare(
    "SELECT count(DISTINCT subject_id) n FROM observations WHERE subject_type = 'person' AND predicate = 'target' AND event_instance_id = ?",
  )
    .bind(instanceId)
    .first();
  return Number(row?.n ?? 0);
}

function beforePlaybook(i: Instance, person: Person, today: string, targets: number): string {
  const away = i.starts_on ? days(today, i.starts_on) : null;
  const icp = person.ideal_customer
    ? `Ideal customer (saved): ${person.ideal_customer}`
    : `Ideal customer: not saved yet. Read ${person.company_url ?? "their company's website"} or ask in one line ("who buys from ${person.company}, and what title signs off?"), confirm it, and save it with save_my_profile (ideal_customer, company_url).`;
  return [
    `PHASE: BEFORE ${i.name} (${dates(i)}${away === null ? "" : away > 0 ? `, ${away} day${away === 1 ? "" : "s"} away` : ", already under way"}). Pass event: "${i.slug}" on every EventHog call.`,
    "Goal: walk in knowing exactly who is worth finding, and why.",
    "",
    `1. Who ${person.company} sells to. ${icp}`,
    "2. Get the attendee list. Load get_skill conference-attendee-export and follow it. It needs a browser that the person has signed in to the event's app or attendee directory (they log in themselves; never ask for their password). Collect name, title, company. If you have no browser: ask for the platform's own attendee export, a CSV, or screenshots of the directory; failing that, use the speaker, sponsor and exhibitor pages on the event's website. If prep/attendees.csv already exists (list_files dir: prep), skip to step 4 unless they want a fresh pull.",
    "3. Save the roster with save_attendees. It's reference, not contacts: nobody gets logged as met from it.",
    `4. Rank it. Load get_skill prioritize-attendees and follow it: screen on title and company, look the likely fits up with enrich_people (25 at a time), use web search for the company check, the reason to talk, and anyone not found, then classify buyer, champion, partner or referral, score A, B or C, and save with save_targets.${targets ? ` (${targets} target(s) already saved for this event: run targets first to see them.)` : ""}`,
    "5. Show the person their 'most useful to find' list: the top 10 to 15, one line each on why and how to spot them (title, booth, session).",
    "6. Close with how the event itself works: during it, they just tell you who they met.",
    '7. Then offer what else helps before the show, as things they can say: "who is <speaker>?", "quiz me on the acronyms", "draft a post saying we\'ll be there". what_can_i_do has the full menu.',
  ].join("\n");
}

async function duringPlaybook(env: Env, i: Instance, person: Person, today: string): Promise<string> {
  const day = i.starts_on ? days(i.starts_on, today) + 1 : null;
  const total = i.starts_on ? days(i.starts_on, i.ends_on || i.starts_on) + 1 : null;
  const capture = person.key && env.PUBLIC_URL ? `${env.PUBLIC_URL}/capture/${await captureToken(person.key)}?event=${encodeURIComponent(i.slug)}` : null;
  return [
    `PHASE: DURING ${i.name}${day && total ? ` (day ${day} of ${total})` : ""}. Pass event: "${i.slug}" on every EventHog call.`,
    "Tell the person, in a short phone-friendly message, how to use EventHog right now:",
    '- Log someone: just say it, the way they would to a teammate. "Met Jane Doe, VP Ops at Acme, at their booth. Worried about chiller efficiency. Send her the case study next week." A photo of a badge or business card works too, and so does a voice-memo transcript. (You: search first, then log_contact with only the fields they gave.)',
    '- Who to find next: "who should I find next?" (You: targets with status not_met.)',
    '- What the team knows: "who have we met from Acme?", "who\'s based in Texas?" (You: search, query_crm, who_is_in.)',
    "- Session takeaways: just tell you; you save them with add_note.",
    capture ? `- Slides: their personal camera page, ${capture} (bookmark it; photos save under their name). Then "write up my slides".` : "- Slides: call slide_capture_link for their personal camera page.",
    '- End of day: "daily brief".',
    "Then ask who they've met so far today. After each thing they log, suggest one next step in a line (who to find next, a follow-up draft, the slide camera); what_can_i_do has the full menu.",
  ].join("\n");
}

async function followUps(env: Env, instanceId: string): Promise<string[]> {
  const { results } = await env.CRM.prepare(
    `SELECT p.name,
            (SELECT o.complete_name FROM affiliations a JOIN organizations o ON o.id = a.org_id WHERE a.person_id = p.id ORDER BY a.added_at DESC LIMIT 1) AS company,
            (SELECT object FROM observations WHERE subject_id = p.id AND predicate = 'has_priority' ORDER BY observed_at DESC LIMIT 1) AS priority,
            i.follow_up, i.logged_by, i.occurred_at
       FROM interactions i
       JOIN interaction_participants ip ON ip.interaction_id = i.id AND ip.role = 'contact'
       JOIN persons p ON p.id = ip.person_id
      WHERE i.event_instance_id = ? AND i.follow_up_done_at IS NULL
      ORDER BY i.occurred_at DESC`,
  )
    .bind(instanceId)
    .all();
  // One line per person: their latest touchpoint, A before B before C, follow-ups before none.
  const seen = new Map<string, any>();
  for (const r of results ?? []) if (!seen.has(r.name)) seen.set(r.name, r);
  const rank = (r: any) => (PRIORITIES.indexOf(String(r.priority ?? "").toUpperCase()) + 4) % 4 + (r.follow_up ? 0 : 4);
  return [...seen.values()]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, FOLLOW_UP_LIMIT)
    .map((r) => `- ${r.priority ? `[${r.priority}] ` : ""}${r.name}${r.company ? `, ${r.company}` : ""} · met by ${r.logged_by}${r.follow_up ? ` · follow-up: ${r.follow_up}` : " · no follow-up noted"}`);
}

async function afterPlaybook(env: Env, i: Instance, person: Person, today: string): Promise<string> {
  const ago = i.starts_on ? days(i.ends_on || i.starts_on, today) : null;
  const list = await followUps(env, i.id);
  return [
    `PHASE: AFTER ${i.name}${ago === null ? "" : ago > 0 ? ` (ended ${ago} day${ago === 1 ? "" : "s"} ago)` : " (wrapping up now)"}. Pass event: "${i.slug}" on every EventHog call.`,
    "Goal: turn the conversations into follow-ups before they go cold.",
    "",
    list.length
      ? `1. Who to follow up with, most important first${list.length === FOLLOW_UP_LIMIT ? ` (top ${FOLLOW_UP_LIMIT}; query_crm has the rest)` : ""}:\n${list.join("\n")}\nShow this to the person and ask which to start with.`
      : "1. Who to follow up with: nobody has been logged at this event yet. Ask whether they have notes, badge photos or business cards to log first (log_contact), then come back to this.",
    "",
    "2. Get them into the CRM. Be plain about it: EventHog does not write to any CRM by itself. It holds the contacts; the person's own CRM connector does the writing.",
    "   - If this agent has a CRM connector (HubSpot's MCP, or another CRM's): run the crm-sync prompt. Ask whose contacts (everyone the team met, just theirs, or theirs plus named teammates) and who owns them (whoever met them, or this person). crm_queue lists who's pending (met_by and owner narrow it) and each conversation to log as a meeting, with a task per follow-up; check the CRM for each contact, propose one review of what you'd create, create only after they approve, then mark_crm_synced and mark_touchpoints_synced with the CRM ids.",
    "   - If it doesn't: tell them how to add one (in Claude: Settings > Connectors, then HubSpot or their CRM), or run export_hubspot_csv for a file most CRMs can import (contacts_csv has everyone).",
    "",
    "3. Draft the follow-up emails. Load get_skill draft-follow-up-emails and follow it: one email per person from what was actually said, saved with save_draft (kind: email). Nothing is sent.",
    "",
    "4. Sending at scale. For more than a handful, point them to Origami (https://origami.chat): it enriches leads (emails, firmographics) and runs email campaigns, with a person approving the send. Its MCP server is https://mcp.origami.chat with an Origami API key (Settings > Developers). If it's connected here, offer to load the approved drafts into a campaign.",
    "",
    '5. Don\'t stop at the CRM. Offer, as things they can say: "recreate that slide in our brand", "turn my notes into a LinkedIn post", "share the write-up with the team". what_can_i_do has the full menu.',
  ].join("\n");
}

// ---------------------------------------------------------------- csv

// RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

// ---------------------------------------------------------------- tools

export const ONBOARDING_TOOLS = [
  {
    name: "get_started",
    description:
      "Start here with anyone new, or when someone says 'get started' or 'set me up'. Call it with what you know; it says what to ask (which company they represent, which conference they're going to, their name), saves their profile, finds or starts the event's workspace, works out whether they're before, during or after the event, and returns that phase's playbook. Follow the playbook.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "The company they represent at the conference" },
        conference: { type: "string", description: "The conference: its name, its website, or an EventHog event slug" },
        name: { type: "string", description: "Their full name (for credit on what they log)" },
        email: { type: "string", description: "Their work email, if they give it" },
        company_url: { type: "string" },
        phase: { type: "string", description: "before, during, or after. Leave out to work it out from the event's dates." },
      },
    },
  },
  {
    name: "save_my_profile",
    description:
      "Save who this person is: name, work email, the company they represent, its website, and its ideal customer in one line (who buys, which titles sign off). Only what they said or you confirmed with them. Blank fields keep their saved values.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        company: { type: "string" },
        company_url: { type: "string" },
        ideal_customer: { type: "string", description: 'One line, e.g. "Facilities and energy directors at K-12 districts and data centers"' },
      },
    },
  },
  {
    name: "save_attendees",
    description:
      "Save an attendee roster from the conference-attendee-export skill into the event's prep/: the attendee CSV (name,title,company, plus source IDs or profile URLs when you have them), and optionally the companies CSV and the coverage summary. Reference only: nobody is logged as met from it. A new save replaces the previous roster (git keeps the old one).",
    inputSchema: {
      type: "object",
      properties: {
        attendees_csv: { type: "string", description: "RFC 4180 CSV with a header row" },
        companies_csv: { type: "string", description: "Distinct companies with attendee counts, if collected" },
        coverage: { type: "string", description: "The coverage summary (JSON or prose): source, capture time, scope, pages, unique people, gaps" },
        source: { type: "string", description: "Where the list came from, e.g. 'Swapcard attendee directory, signed in as …'" },
        event: { type: "string" },
      },
      required: ["attendees_csv"],
    },
  },
  {
    name: "save_targets",
    description: `Save ranked targets from the prioritize-attendees skill: who is worth finding at this event and why. Appends a ranked section to prep/targets.md and records each person as a target (with priority, role and reason) in the database, so log_contact later attaches to the same person and targets can tell met from not-yet-met. Up to ${MAX_TARGETS} per call; call again for more. Only include facts you found or were told, with sources.`,
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              company: { type: "string" },
              title: { type: "string" },
              linkedin: { type: "string" },
              email: { type: "string", description: "Work email, only if found (e.g. by enrich_people)" },
              priority: { type: "string", description: "A (must find), B (good to meet), C (if you cross paths)" },
              role: { type: "string", description: ROLES.join(", ") },
              why: { type: "string", description: "One line: why they matter to this company" },
              how_to_spot: { type: "string", description: "Booth, session, panel, or what they look like on the floor" },
              sources: { type: "array", items: { type: "string" }, description: "URLs actually retrieved" },
            },
            required: ["name", "priority", "why"],
          },
        },
        event: { type: "string" },
      },
      required: ["targets"],
    },
  },
  {
    name: "targets",
    description: "The event's targets (from save_targets) with priority, why, and whether anyone on the team has met them yet and who. Use for 'who should I find next?' (status not_met) and 'which targets did we get to?' (status met).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "all (default), not_met, or met" },
        priority: { type: "string", description: "Only this priority: A, B or C" },
        event: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

async function instanceFor(env: Env, event: string): Promise<string> {
  const row = await env.CRM.prepare("SELECT id FROM event_instances WHERE slug = ?").bind(event).first();
  if (!row) throw new Error(`No event called ${event}. list_events shows them; new_event starts one.`);
  return row.id as string;
}

export const ONBOARDING_HANDLERS: Record<string, Handler> = {
  async get_started(args, env, person) {
    const saved = await saveProfile(env, person, args);
    const company = person.company;
    const name = person.guest ? null : person.name;
    const conference = String(args?.conference ?? "").trim();

    const missing: string[] = [];
    if (!company) missing.push("1. What company do you represent at the conference?");
    if (!conference) missing.push(`${missing.length + 1}. Which conference are you going to? (Its name or website.)`);
    if (!name) missing.push(`${missing.length + 1}. What's your name? (So what you log is credited to you.)`);
    const noEmail = !person.email || /@eventhog\.invalid$/i.test(person.email);
    if (missing.length && noEmail) missing.push(`${missing.length + 1}. Your work email? (Optional. It's how the contacts you log get assigned to you in your CRM.)`);
    if (missing.length) {
      return [
        saved.length ? `Saved: ${saved.join(", ")}.` : "",
        "Ask the person, in one short friendly message (skip anything they've already told you in this conversation):",
        ...missing,
        "Then call get_started again with their answers (company, conference, name, and email if they gave it).",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const { results } = await env.CRM.prepare(
      "SELECT id, slug, name, starts_on, ends_on, time_zone, website, city FROM event_instances WHERE artifacts_repo IS NOT NULL ORDER BY starts_on",
    ).all();
    const matches = matchEvents((results ?? []) as Instance[], conference);
    const hello = `${name} (${company})${saved.length ? `. Saved to their profile: ${saved.join(", ")}` : ""}.`;

    if (!matches.length) {
      return [
        `${hello} "${conference}" has no EventHog workspace yet.`,
        "Set one up:",
        "1. Look up the conference with web search: its official name for this occurrence, start and end dates, city, venue, IANA time zone, website, and organizer. Never guess dates.",
        "2. Confirm those with the person in one message.",
        "3. Call new_event with them (and why they're going, if they said).",
        "4. Call get_started again with conference set to the new workspace's slug.",
      ].join("\n");
    }
    const tied = matches.filter((m) => m.score === matches[0].score);
    if (tied.length > 1) {
      return [
        `${hello} "${conference}" could be more than one event:`,
        ...tied.slice(0, 5).map(({ i: m }) => `- ${m.slug}: ${m.name} (${dates(m)}${m.city ? `, ${m.city}` : ""})`),
        "Ask which one (or whether it's a different year, which needs new_event), then call get_started again with that slug as conference.",
      ].join("\n");
    }

    const i = matches[0].i;
    const today = todayIn(i.time_zone, env.EVENT_TIMEZONE);
    const asked = ["before", "during", "after"].includes(String(args?.phase)) ? (args.phase as Phase) : null;
    const phase = asked ?? guessPhase(i, today);
    const intro = `${hello} Event: ${i.name} (${i.slug}, ${dates(i)}${i.city ? `, ${i.city}` : ""}). If that isn't the event they mean, ask and use new_event.`;
    if (!phase) {
      return `${intro}\nThe event has no dates on file, so ask: are they getting ready for it, there now, or following up after? Then call get_started again with phase.`;
    }
    const guessed = asked ? "" : ` (worked out from today, ${today}, and the event's dates; if they say otherwise, call get_started again with phase)`;
    const body =
      phase === "before"
        ? beforePlaybook(i, person, today, await targetCount(env, i.id))
        : phase === "during"
          ? await duringPlaybook(env, i, person, today)
          : await afterPlaybook(env, i, person, today);
    const emailAsk = noEmail
      ? "\nNo work email saved for them. Ask for it once, in passing (save_my_profile email): without it, contacts they log can't be assigned to them in a CRM. Don't press if they skip it."
      : "";
    return `${intro}\nPhase: ${phase}${guessed}.${emailAsk}\n\n${body}`;
  },

  async save_my_profile(args, env, person) {
    const saved = await saveProfile(env, person, args);
    if (!saved.length) throw new Error("Nothing to save: give at least one of name, email, company, company_url, ideal_customer.");
    return `Saved ${saved.join(", ")} for ${person.name}${person.company ? ` (${person.company})` : ""}.`;
  },

  async save_attendees(args, env, person) {
    const csv = String(args?.attendees_csv ?? "").replace(/^\uFEFF/, "");
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new Error("attendees_csv needs a header row and at least one attendee.");
    const header = rows[0].map((h) => h.trim().toLowerCase());
    if (!header.some((h) => h.includes("name"))) throw new Error(`The header has no name column: ${rows[0].join(", ")}.`);
    const count = rows.length - 1;
    return write(env, ev(args, env), person, `prep: attendee roster (${count} people)`, async (ws) => {
      const t = now(env);
      await ws.fs.promises.mkdir(`${DIR}/prep`, { recursive: true } as any).catch(() => {});
      const paths = ["prep/attendees.csv"];
      await ws.fs.promises.writeFile(`${DIR}/prep/attendees.csv`, csv.replace(/\s*$/, "\n"));
      if (args?.companies_csv) {
        await ws.fs.promises.writeFile(`${DIR}/prep/attendee-companies.csv`, String(args.companies_csv).replace(/\s*$/, "\n"));
        paths.push("prep/attendee-companies.csv");
      }
      const coverage = [
        "---",
        `saved_at: ${t.iso}`,
        `saved_by: ${JSON.stringify(person.name)}`,
        `attendees: ${count}`,
        ...(args?.source ? [`source: ${JSON.stringify(String(args.source))}`] : []),
        "---",
        "# Attendee roster: coverage",
        "",
        "Reference, not contacts: nobody here has been met until log_contact says so.",
        "",
        args?.coverage ? String(args.coverage).trim() : "(No coverage summary was given.)",
        "",
      ].join("\n");
      await ws.fs.promises.writeFile(`${DIR}/prep/attendee-coverage.md`, coverage);
      paths.push("prep/attendee-coverage.md");
      return {
        paths,
        summary: `Saved ${count} attendee(s) to prep/attendees.csv${args?.companies_csv ? " (plus prep/attendee-companies.csv)" : ""} and the coverage note to prep/attendee-coverage.md. Next: prioritize-attendees.`,
      };
    });
  },

  async save_targets(args, env, person) {
    const list = (Array.isArray(args?.targets) ? args.targets : []).filter((x: any) => x?.name && x?.why);
    if (!list.length) throw new Error("Give at least one target with a name, priority and why.");
    if (list.length > MAX_TARGETS) throw new Error(`At most ${MAX_TARGETS} targets per call. Send the first ${MAX_TARGETS}, then the rest.`);
    for (const x of list) {
      x.priority = String(x.priority ?? "").trim().toUpperCase();
      if (!PRIORITIES.includes(x.priority)) throw new Error(`${x.name}: priority must be A, B or C.`);
      if (x.role && !ROLES.includes(String(x.role).toLowerCase())) throw new Error(`${x.name}: role must be one of ${ROLES.join(", ")}.`);
    }
    const event = ev(args, env);
    const path = "prep/targets.md";
    return write(
      env,
      event,
      person,
      `prep: ${list.length} target(s)`,
      async (ws) => {
        const t = now(env);
        const order = [...list].sort((a: any, b: any) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
        const lines = order.map((x: any) => {
          const who = [x.name, x.title, x.company].filter(Boolean).join(", ");
          const extra = [
            x.role ? `role: ${String(x.role).toLowerCase()}` : null,
            x.how_to_spot ? `spot: ${x.how_to_spot}` : null,
            x.linkedin ? x.linkedin : null,
            x.email ? x.email : null,
          ].filter(Boolean);
          const src = Array.isArray(x.sources) && x.sources.length ? `\n  Sources: ${x.sources.join(" · ")}` : "";
          return `- **[${x.priority}] ${who}** — ${x.why}${extra.length ? ` (${extra.join("; ")})` : ""}${src}`;
        });
        const current = (await read(ws, path)) ?? "# Targets\n\nWho is worth finding at this event, and why. Ranked by prioritize-attendees; met or not is in the targets tool.\n";
        await ws.fs.promises.mkdir(`${DIR}/prep`, { recursive: true } as any).catch(() => {});
        await ws.fs.promises.writeFile(`${DIR}/${path}`, `${current.replace(/\s*$/, "\n\n")}### ${t.stamp} · ranked by ${person.name}\n\n${lines.join("\n")}\n`);
        return { paths: [path], summary: `Saved ${list.length} target(s) to ${path}.` };
      },
      async (oid) => {
        const at = new Date().toISOString();
        const source = `event-hog:${event}@${oid.slice(0, 12)}:${path}`;
        const instanceId = await ensureInstance(env, event);
        let added = 0;
        for (const x of list) {
          const orgId = x.company ? await ensureOrg(env, String(x.company), source) : null;
          let personId = await findPerson(env, { name: x.name, linkedin: x.linkedin, email: x.email }, orgId);
          const stmts: any[] = [];
          if (!personId) {
            personId = crypto.randomUUID();
            added++;
            stmts.push(
              env.CRM.prepare(
                "INSERT INTO persons (id, name, headline, linkedin_url, source, first_seen_at, last_seen_at, first_touched_by, last_touched_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              ).bind(personId, String(x.name).trim(), x.title ?? null, x.linkedin ?? null, source, at, at, person.name, person.name),
            );
            if (orgId) {
              stmts.push(
                env.CRM.prepare("INSERT OR IGNORE INTO affiliations (id, person_id, org_id, kind, added_at, source) VALUES (?, ?, ?, ?, ?, ?)").bind(
                  crypto.randomUUID(), personId, orgId, x.title ?? "", at, source,
                ),
              );
            }
            if (x.linkedin) {
              const li = String(x.linkedin).trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
              stmts.push(env.CRM.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, added_at) VALUES (?, 'linkedin', ?, ?)").bind(personId, li, at));
            }
            if (x.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x.email).trim())) {
              stmts.push(
                env.CRM.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, added_at) VALUES (?, 'email', ?, ?)").bind(
                  personId, String(x.email).trim().toLowerCase(), at,
                ),
              );
            }
          }
          const obs = (predicate: string, object: string) =>
            env.CRM.prepare(
              "INSERT INTO observations (id, subject_type, subject_id, predicate, object, source, observed_at, observed_by, event_instance_id) VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)",
            ).bind(crypto.randomUUID(), personId, predicate, object, source, at, person.name, instanceId);
          stmts.push(obs("target", String(x.role ?? "target").toLowerCase()), obs("has_priority", x.priority), obs("target_reason", String(x.why)));
          if (x.how_to_spot) stmts.push(obs("how_to_spot", String(x.how_to_spot)));
          await env.CRM.batch(stmts);
        }
        return `agnostic-crm: ${list.length} target(s) recorded (${added} new to the database, ${list.length - added} already known).`;
      },
    );
  },

  async targets(args, env) {
    const event = ev(args, env);
    const instanceId = await instanceFor(env, event);
    const { results } = await env.CRM.prepare(
      `WITH t AS (SELECT DISTINCT subject_id AS id FROM observations WHERE subject_type = 'person' AND predicate = 'target' AND event_instance_id = ?1)
       SELECT p.id, p.name, p.headline,
         (SELECT o.complete_name FROM affiliations a JOIN organizations o ON o.id = a.org_id WHERE a.person_id = p.id ORDER BY a.added_at DESC LIMIT 1) AS company,
         (SELECT object FROM observations WHERE subject_id = p.id AND predicate = 'has_priority' AND event_instance_id = ?1 ORDER BY observed_at DESC LIMIT 1) AS priority,
         (SELECT object FROM observations WHERE subject_id = p.id AND predicate = 'target' AND event_instance_id = ?1 ORDER BY observed_at DESC LIMIT 1) AS role,
         (SELECT object FROM observations WHERE subject_id = p.id AND predicate = 'target_reason' AND event_instance_id = ?1 ORDER BY observed_at DESC LIMIT 1) AS why,
         (SELECT object FROM observations WHERE subject_id = p.id AND predicate = 'how_to_spot' AND event_instance_id = ?1 ORDER BY observed_at DESC LIMIT 1) AS spot,
         (SELECT i.logged_by || ' on ' || substr(i.occurred_at, 1, 10) FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id
            WHERE ip.person_id = p.id AND i.event_instance_id = ?1 ORDER BY i.occurred_at DESC LIMIT 1) AS met
       FROM persons p JOIN t ON t.id = p.id`,
    )
      .bind(instanceId)
      .all();
    const status = String(args?.status ?? "all");
    const only = args?.priority ? String(args.priority).toUpperCase() : null;
    const rows = ((results ?? []) as any[])
      .filter((r) => (status === "met" ? r.met : status === "not_met" ? !r.met : true))
      .filter((r) => !only || String(r.priority).toUpperCase() === only)
      .sort((a, b) => (PRIORITIES.indexOf(a.priority) + 4) % 4 - (PRIORITIES.indexOf(b.priority) + 4) % 4 || String(a.name).localeCompare(String(b.name)));
    if (!rows.length) {
      return status === "not_met" ? "Every target has been met, or none are saved yet (run prioritize-attendees and save_targets)." : "No targets saved for this event yet. The prioritize-attendees skill builds them.";
    }
    const total = (results ?? []).length;
    const met = (results ?? []).filter((r: any) => r.met).length;
    return [
      `${rows.length} target(s) shown · ${met} of ${total} met so far.`,
      ...rows.map(
        (r) =>
          `- [${r.priority ?? "?"}] ${r.name}${r.headline ? `, ${r.headline}` : ""}${r.company ? `, ${r.company}` : ""}${r.role ? ` (${r.role})` : ""} — ${r.why ?? ""}${r.spot ? ` · spot: ${r.spot}` : ""} · ${r.met ? `met by ${r.met}` : "not met yet"}`,
      ),
    ].join("\n");
  },
};

export const ONBOARDING_PROMPTS = [
  {
    name: "get-started",
    description: "Set me up: which company, which conference, and what to do now (before, during or after).",
    text: "Use EventHog: call get_started and follow what it says.",
  },
];