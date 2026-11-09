// A team's Durable Object. Every team except home runs in one of these.
//
// The Worker resolves the connector key against the registry (main D1), then
// hands the caller's whole MCP message, capture-page post or upload to their
// team's object in a single RPC. The object runs the same handlers the home
// team runs in the Worker, with env scoped to the team (teamEnv): CRM is the
// object's own SQLite database, so every query a tool makes stays on this
// machine. The registry stays in the main D1, reachable as ACCESS_DB.
//
// The database holds the CRM schema (migrations/ minus the registry, bundled
// by scripts/bundle-kit.mjs), applied in the constructor before any call runs.

import { DurableObject } from "cloudflare:workers";
import type { Env, Person } from "./index";
import { respond } from "./index";
import { withCurrentEvent } from "./events";
import { handleCapture } from "./slides";
import { handleUpload } from "./uploads";
import { MIGRATIONS } from "./migrations.generated";

const TEAM_ID = /^[a-f0-9]{10}$/;

export class Team extends DurableObject<Env> {
  private readonly db: LocalD1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = localD1(ctx.storage);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  /** One MCP message (or a batch); null for notifications. */
  async call(body: unknown, person: Person): Promise<unknown> {
    return respond(body, await withCurrentEvent(this.teamEnv(person.team)), person);
  }

  async capture(request: Request, team: string, token: string): Promise<Response> {
    return handleCapture(request, await withCurrentEvent(this.teamEnv(team)), token);
  }

  async upload(request: Request, team: string, token: string): Promise<Response> {
    return handleUpload(request, this.teamEnv(team), token);
  }

  /** Erase the team's database (delete_team). */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private teamEnv(team: string | undefined): Env {
    if (!team || !TEAM_ID.test(team)) throw new Error(`Not a team id: ${team}`);
    return teamEnv(this.env, team, this.db);
  }
}

// The Worker's env, scoped to one team: its own database, repos, kit and
// media; no CRM brain, no paid lookups, no PEOPLE.
export function teamEnv(env: Env, team: string, db: LocalD1): Env {
  return {
    ...env,
    CRM: db,
    ACCESS_DB: env.CRM,
    TEAM_ID: team,
    TEAM_PREFIX: `tm-${team}-`,
    KIT_REPO: `tm-${team}-kit`,
    MEDIA_PREFIX: `teams/${team}/`,
    DEFAULT_EVENT: "",
    PEOPLE: "",
    BRAIN: undefined,
    SKILLS_REPO: "",
    CONTEXT_DEV_API_KEY: undefined,
  };
}

function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(sql.exec<{ name: string }>("SELECT name FROM _migrations").toArray().map((r) => r.name));
  for (const [name, text] of MIGRATIONS) {
    if (done.has(name)) continue;
    storage.transactionSync(() => {
      sql.exec(text);
      sql.exec("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", name, new Date().toISOString());
    });
  }
}

// ---------------------------------------------------------------- D1 shape over local SQLite

// The handlers only use prepare().bind().first()/all()/run() and batch(), so
// that much of D1's API is enough. batch() is one transaction, as in D1.

type Result = { results: Record<string, SqlStorageValue>[]; success: true; meta: { changes: number } };

const param = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);

class Statement {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly query: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.storage, this.query, params);
  }

  execute(): Result {
    const cursor = this.storage.sql.exec(this.query, ...this.params.map(param));
    const results = cursor.toArray();
    return { results, success: true, meta: { changes: cursor.rowsWritten } };
  }

  async all(): Promise<Result> {
    return this.execute();
  }

  async run(): Promise<Result> {
    return this.execute();
  }

  async first(column?: string): Promise<any> {
    const row = this.execute().results[0] ?? null;
    return column ? (row?.[column] ?? null) : row;
  }
}

export type LocalD1 = ReturnType<typeof localD1>;

export function localD1(storage: DurableObjectStorage) {
  return {
    prepare: (query: string) => new Statement(storage, query),
    batch: async (statements: Statement[]): Promise<Result[]> => storage.transactionSync(() => statements.map((s) => s.execute())),
  };
}
