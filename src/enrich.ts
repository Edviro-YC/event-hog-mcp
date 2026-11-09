// enrich_people: look attendees up (current role, LinkedIn, sometimes a work
// email) through context.dev's People Enrich, with the team's key held as a
// Worker secret. The person's agent only sees this tool. Every answer,
// misses included, is cached in the enrichments table, so the same person
// is never paid for twice.

import type { Env, Handler } from "./index";

const API = "https://api.context.dev/v1/people/enrich";
const MAX_PEOPLE = 25;
// The free tier allows 2 requests in flight.
const CONCURRENCY = 2;
const TIMEOUT_MS = 25_000;
const CONFIRMED = 70;
const UNCONFIRMED = 40;
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "pe", "phd", "mba", "cpa", "pmp", "esq"]);
const FALLBACK = "Use your own web search for these (confirm the person is at that company in that role now, and only report links you retrieved).";

type Row = {
  lookup_key: string;
  name: string;
  company: string;
  status: "candidate" | "not_found";
  score: number | null;
  title: string | null;
  organization: string | null;
  org_domain: string | null;
  linkedin: string | null;
  email: string | null;
  location: string | null;
  checked_at: string | null;
  last_updated: string | null;
  credits: number;
  raw: string | null;
};

const keyOf = (name: string, company: string) => `${name.trim().toLowerCase()}|${company.trim().toLowerCase()}`;

function splitName(full: string): { first: string; last: string } | null {
  const parts = full
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s,]+/)
    .filter((p) => p && !SUFFIXES.has(p.toLowerCase().replace(/\./g, "")));
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function toRow(name: string, company: string, body: any): Row {
  const m = body?.match;
  const p = m?.status === "candidate" ? m.person : null;
  const role = p?.current_role;
  const linkedin = (p?.social_urls ?? []).find((u: string) => /linkedin\.com\/in\//i.test(u)) ?? null;
  return {
    lookup_key: keyOf(name, company),
    name: name.trim(),
    company: company.trim(),
    status: p ? "candidate" : "not_found",
    score: p ? Number(m.score) : null,
    title: role?.title ?? null,
    organization: role?.organization?.name ?? null,
    org_domain: role?.organization?.domain ?? null,
    linkedin,
    email: p?.email ?? null,
    location: p?.location?.display ?? null,
    checked_at: p?.checked_at ?? null,
    last_updated: p?.last_updated ?? null,
    credits: Number(body?.key_metadata?.credits_consumed ?? 0),
    raw: JSON.stringify(body),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const sameOrg = (a: string, b: string) => {
  const x = norm(a.replace(/\b(inc|llc|ltd|corp|corporation|company|co|group)\b\.?/gi, ""));
  const y = norm(b.replace(/\b(inc|llc|ltd|corp|corporation|company|co|group)\b\.?/gi, ""));
  return !x || !y || x.includes(y) || y.includes(x);
};

function line(r: Row, cached: boolean): string {
  const who = `${r.name} (${r.company})`;
  if (r.status === "not_found" || (r.score ?? 0) < UNCONFIRMED) return `- ${who}: not found.${cached ? " (cached)" : ""}`;
  const band = (r.score ?? 0) >= CONFIRMED ? `confirmed (${r.score})` : `UNCONFIRMED (${r.score}): check before using`;
  const role = [r.title, r.organization ? `at ${r.organization}${r.org_domain ? ` (${r.org_domain})` : ""}` : null].filter(Boolean).join(" ");
  const moved = r.organization && !sameOrg(r.organization, r.company) ? `employer differs from the roster (${r.organization})` : null;
  const bits = [
    band,
    role || "current role unknown",
    moved,
    r.linkedin,
    r.email ? `email ${r.email} (unverified)` : "no email",
    r.location,
    r.checked_at ? `profile checked ${r.checked_at.slice(0, 10)}` : null,
  ].filter(Boolean);
  return `- ${who}: ${bits.join(" · ")}${cached ? " (cached)" : ""}`;
}

export const ENRICH_TOOLS = [
  {
    name: "enrich_people",
    description: `EventHog's people lookup. For roster entries (name + company), returns each person's current title and employer, LinkedIn, location, sometimes a work email, and a match band: confirmed, UNCONFIRMED (verify with web search before using), or not found. Use it in prioritize-attendees on the plausible fits before any web search; it's faster and the results are shared with the team. Up to ${MAX_PEOPLE} people per call. People already looked up come back from the team's cache. Emails are unverified for deliverability.`,
    inputSchema: {
      type: "object",
      properties: {
        people: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Full name as on the roster" },
              company: { type: "string", description: "Company as on the roster" },
              title: { type: "string", description: "Title as on the roster, if any" },
            },
            required: ["name", "company"],
          },
        },
        refresh: { type: "boolean", description: "Look up again even if cached (spends credits). Default false." },
      },
      required: ["people"],
    },
  },
];

export const ENRICH_HANDLERS: Record<string, Handler> = {
  async enrich_people(args, env, person) {
    const given = (Array.isArray(args?.people) ? args.people : [])
      .map((x: any) => ({ name: String(x?.name ?? "").trim(), company: String(x?.company ?? "").trim() }))
      .filter((x: any) => x.name);
    if (!given.length) throw new Error("Give at least one person with a name and company.");
    if (given.length > MAX_PEOPLE) throw new Error(`At most ${MAX_PEOPLE} people per call. Send the first ${MAX_PEOPLE}, then the rest.`);

    const out = new Map<string, string>();
    const skipped: string[] = [];
    const queue: { name: string; company: string; first: string; last: string }[] = [];
    const seen = new Set<string>();
    for (const x of given) {
      if (!x.company) {
        skipped.push(`${x.name}: no company on the roster`);
        continue;
      }
      const k = keyOf(x.name, x.company);
      if (seen.has(k)) continue;
      seen.add(k);
      const n = splitName(x.name);
      if (!n) skipped.push(`${x.name}: needs a first and last name`);
      else queue.push({ ...x, ...n });
    }

    let cachedCount = 0;
    if (!args?.refresh && queue.length) {
      const keys = queue.map((q) => keyOf(q.name, q.company));
      const { results } = await env.CRM.prepare(`SELECT * FROM enrichments WHERE lookup_key IN (${keys.map(() => "?").join(",")})`)
        .bind(...keys)
        .all();
      for (const r of (results ?? []) as Row[]) {
        out.set(r.lookup_key, line(r, true));
        cachedCount++;
      }
    }
    const todo = queue.filter((q) => !out.has(keyOf(q.name, q.company)));

    if (todo.length && !env.CONTEXT_DEV_API_KEY) {
      for (const q of todo) skipped.push(`${q.name} (${q.company}): the people lookup isn't set up on this server`);
      todo.length = 0;
    }

    const fresh: Row[] = [];
    const errors: string[] = [];
    let stop: string | null = null;
    let remaining: number | null = null;
    let spent = 0;
    let looked = 0;
    let next = 0;

    const worker = async () => {
      while (!stop && next < todo.length) {
        const q = todo[next++];
        let res: Response;
        try {
          res = await fetch(API, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.CONTEXT_DEV_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: { first: q.first, last: q.last }, company: { name: q.company }, tags: ["event-hog"] }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (err: any) {
          errors.push(`${q.name} (${q.company}): ${err?.name === "TimeoutError" ? "timed out" : "lookup failed"}`);
          continue;
        }
        const body: any = await res.json().catch(() => ({}));
        const left = body?.key_metadata?.credits_remaining ?? body?.error_data?.credits_remaining;
        if (typeof left === "number") remaining = left;
        if (res.ok) {
          const row = toRow(q.name, q.company, body);
          looked++;
          spent += row.credits;
          if (!body?.partial) fresh.push(row);
          out.set(row.lookup_key, line(row, false));
        } else if (res.status === 402) {
          stop = "The people lookup is out of credits for now.";
        } else if (res.status === 429) {
          stop = "The people lookup is busy or rate-limited right now.";
        } else if (res.status === 401 || res.status === 403) {
          stop = "The people lookup isn't authorized on this server.";
        } else if (res.status === 400 || res.status === 422) {
          errors.push(`${q.name} (${q.company}): not enough to identify them`);
        } else {
          errors.push(`${q.name} (${q.company}): lookup failed (${res.status})`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

    if (fresh.length) {
      const at = new Date().toISOString();
      await env.CRM.batch(
        fresh.map((r) =>
          env.CRM.prepare(
            `INSERT INTO enrichments (lookup_key, name, company, status, score, title, organization, org_domain, linkedin, email, location, checked_at, last_updated, credits, raw, enriched_at, enriched_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (lookup_key) DO UPDATE SET status = excluded.status, score = excluded.score, title = excluded.title,
               organization = excluded.organization, org_domain = excluded.org_domain, linkedin = excluded.linkedin, email = excluded.email,
               location = excluded.location, checked_at = excluded.checked_at, last_updated = excluded.last_updated,
               credits = enrichments.credits + excluded.credits, raw = excluded.raw, enriched_at = excluded.enriched_at, enriched_by = excluded.enriched_by`,
          ).bind(
            r.lookup_key, r.name, r.company, r.status, r.score, r.title, r.organization, r.org_domain, r.linkedin, r.email,
            r.location, r.checked_at, r.last_updated, r.credits, r.raw, at, person.name,
          ),
        ),
      );
    }

    const notReached = todo.filter((q) => !out.has(keyOf(q.name, q.company)) && !errors.some((e) => e.startsWith(`${q.name} (${q.company})`)));
    const lines = queue.map((q) => out.get(keyOf(q.name, q.company))).filter(Boolean) as string[];
    return [
      ...lines,
      ...(errors.length ? ["", "Couldn't look up:", ...errors.map((e) => `- ${e}`)] : []),
      ...(skipped.length ? ["", "Skipped:", ...skipped.map((s) => `- ${s}`)] : []),
      ...(stop ? ["", `${stop} Not looked up: ${notReached.map((q) => q.name).join(", ") || "none"}.`] : []),
      "",
      `${looked} looked up now (${spent} credits), ${cachedCount} from the team's cache${remaining !== null ? ` · ${remaining} credits left this month` : ""}.`,
      errors.length || skipped.length || stop ? FALLBACK : "",
      "Not found or UNCONFIRMED: check with web search before treating them as identified. Pass linkedin and email to save_targets for anyone you keep.",
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },
};
