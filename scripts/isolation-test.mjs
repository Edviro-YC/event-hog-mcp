// Two-team isolation check against a running event-hog with SELF_SERVE="teams"
// (wrangler dev, or a preview URL from wrangler versions upload):
//
//   node scripts/isolation-test.mjs <base-url> <home-connector-key>
//
// Starts two fresh teams that each create the same event (same slug), log a
// contact, upload a photo and capture a slide. Then checks that neither team,
// nor the home team, can list, open, search or query the other's data; that
// team media lands under teams/<id>/; that enrich_people is refused for teams;
// and that add_person adds to the inviter's team only.
//
// If the home key is an admin, it ends by deleting both teams with
// delete_team (repos, media, database, connectors) and checks they're gone.
// Otherwise it prints the team ids, for deleting.

const [base = "http://localhost:8799", homeKey] = process.argv.slice(2);
if (!homeKey) {
  console.error("Usage: node scripts/isolation-test.mjs <base-url> <home-connector-key>");
  process.exit(2);
}

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
// The smallest file the upload checks accept as a JPEG: the magic bytes are what's checked.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let id = 0;
async function rpc(key, method, params) {
  const res = await fetch(`${base}/mcp/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function tool(key, name, args = {}) {
  const out = await rpc(key, "tools/call", { name, arguments: args });
  if (out.error) throw new Error(`${name}: ${out.error.message}`);
  return { text: out.result.content.map((c) => c.text ?? "").join("\n"), error: !!out.result.isError };
}

const results = [];
function check(label, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n     ${String(detail).slice(0, 500).replace(/\n/g, "\n     ")}`}`);
}

const year = new Date().getUTCFullYear() + 1;
const slug = `${year}-03-isolation-test`;
const EVENT = { name: `Isolation Test Conference ${year}`, short_name: "Isolation Test", starts_on: `${year}-03-10`, ends_on: `${year}-03-12`, time_zone: "America/Chicago", city: "Austin, TX" };

async function upload(key) {
  const link = await tool(key, "upload_link", { kind: "photo", filename: "badge.jpg", event: slug });
  const url = link.text.match(/'(https?:\/\/[^']+\/upload\/[^']+)'/)?.[1];
  if (!url) return { error: link.text };
  const res = await fetch(url, { method: "PUT", body: JPEG });
  return res.json();
}

async function captureSlide(key, founder) {
  const link = await tool(key, "slide_capture_link", { event: slug });
  const url = link.text.match(/(https?:\/\/\S+\/capture\/[a-f0-9]{32}\S*)/)?.[1];
  if (!url) return { error: link.text };
  const page = await fetch(url, { headers: { accept: "text/html" } });
  const html = await page.text();
  const form = new FormData();
  form.set("event", slug);
  form.set("session", "Isolation keynote");
  form.append("slide", new Blob([JPEG], { type: "image/jpeg" }), "slide.jpg");
  form.set("meta", "[]");
  const res = await fetch(url.split("?")[0], { method: "POST", body: form });
  return { pageOk: page.ok && html.includes(founder), ...(await res.json()) };
}

async function startTeam(label, company) {
  const key = hex(24);
  const founder = `${label} Founder`;
  await rpc(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isolation-test", version: "1" } });
  const who = await tool(key, "whoami");
  check(`${label}: a fresh key starts its own team, as its admin`, /your own team/.test(who.text) && /You're an admin/.test(who.text), who.text);
  await tool(key, "save_my_profile", { name: founder, email: `founder@${company.toLowerCase()}.test`, company });
  const named = await tool(key, "whoami");
  check(`${label}: the team takes the founder's company as its name`, named.text.includes(`${company}'s team`), named.text);
  const ev = await tool(key, "new_event", EVENT);
  check(`${label}: new_event starts ${slug}`, !ev.error && ev.text.includes(`Started ${slug}`), ev.text);
  const c = await tool(key, "log_contact", { name: `${label} Contact`, company: `${company} Prospect`, email: `contact@${company.toLowerCase()}-prospect.test`, notes: `Secret note from ${label}`, event: slug });
  check(`${label}: log_contact saves to the team's event and database`, !c.error && /agnostic-crm|Saved as commit/.test(c.text), c.text);
  const up = await upload(key);
  const team = up.url?.match(/\/media\/teams\/([a-f0-9]{10})\//)?.[1];
  check(`${label}: an upload lands under teams/<id>/`, !!team, JSON.stringify(up));
  if (up.url) check(`${label}: the uploaded file is served`, (await fetch(up.url)).ok);
  const slide = await captureSlide(key, founder);
  check(`${label}: the capture page opens and saves a slide`, slide.pageOk && slide.ok, JSON.stringify(slide));
  const slideFile = slide.saved?.[0] ? await tool(key, "read_file", { path: slide.saved[0], event: slug }) : { text: "" };
  check(`${label}: the slide image is under teams/<id>/`, team && slideFile.text.includes(`/media/teams/${team}/`), slideFile.text);
  return { key, label, company, team, founder, media: up.url };
}

const a = await startTeam("Team A", "Acme");
const b = await startTeam("Team B", "Bolt");

for (const [me, other] of [[a, b], [b, a]]) {
  const p = `${me.label} vs ${other.label}`;
  const events = await tool(me.key, "list_events");
  check(`${p}: list_events shows only its own event`, (events.text.match(new RegExp(slug, "g")) ?? []).length === 1 && !events.text.includes("tm-"), events.text);
  const found = await tool(me.key, "search", { query: `Secret note from ${other.label}`, event: slug });
  check(`${p}: search can't find the other team's contact`, /Nothing matches/.test(found.text), found.text);
  const own = await tool(me.key, "search", { query: `Secret note from ${me.label}`, event: slug });
  check(`${p}: search finds its own contact`, own.text.includes("contacts/"), own.text);
  const reach = await tool(me.key, "read_file", { path: "README.md", event: `tm-${other.team}-${slug}` });
  check(`${p}: naming the other team's repo is refused`, reach.error, reach.text);
  const rows = await tool(me.key, "query_crm", { sql: "SELECT name FROM persons" });
  check(`${p}: query_crm sees only its own people`, rows.text.includes(`${me.label} Contact`) && !rows.text.includes(`${other.label} Contact`), rows.text);
  const registry = await tool(me.key, "query_crm", { sql: "SELECT * FROM connector_people" });
  check(`${p}: query_crm can't read the registry`, registry.error, registry.text);
  const enrich = await tool(me.key, "enrich_people", { people: [{ name: "Jane Doe", company: "Acme" }] });
  check(`${p}: enrich_people is refused for teams`, /deploy your own event-hog/.test(enrich.text), enrich.text);
}

// The home team can't see either team.
const homeWho = await tool(homeKey, "whoami");
check("Home: whoami names the home team", /You're in .*team/.test(homeWho.text) && !/your own team/.test(homeWho.text), homeWho.text);
const homeEvents = await tool(homeKey, "list_events");
check("Home: list_events skips team repos", !homeEvents.text.includes("tm-") && !homeEvents.text.includes(slug), homeEvents.text);
const homeReach = await tool(homeKey, "read_file", { path: "README.md", event: `tm-${a.team}-${slug}` });
check("Home: naming a team's repo is refused", homeReach.error, homeReach.text);
const homeRows = await tool(homeKey, "query_crm", { sql: "SELECT name FROM persons" });
check("Home: query_crm doesn't see team rows", !homeRows.text.includes("Team A Contact") && !homeRows.text.includes("Team B Contact"), homeRows.text);

// Teammates: add_person adds to the inviter's team only.
const invite = await tool(a.key, "add_person", { name: "Alex Acme", email: "alex@acme.test" });
const mate = invite.text.match(/\/mcp\/([a-f0-9]{48})/)?.[1];
check("Team A: add_person returns a connector URL", !!mate, invite.text);
if (mate) {
  const mateWho = await tool(mate, "whoami");
  check("Teammate: whoami says Acme's team", mateWho.text.includes("Acme's team") && !/You're an admin/.test(mateWho.text), mateWho.text);
  const mateSees = await tool(mate, "search", { query: "Secret note from Team A", event: slug });
  check("Teammate: sees Team A's contact", mateSees.text.includes("contacts/"), mateSees.text);
  const mateAdds = await tool(mate, "add_person", { name: "Nope", email: "nope@acme.test" });
  check("Teammate: can't add people (not an admin)", mateAdds.error, mateAdds.text);
}
const listA = await tool(a.key, "list_people");
const listB = await tool(b.key, "list_people");
check("Team A: list_people shows its 2 people", /^2 connector\(s\)/.test(listA.text) && listA.text.includes("Alex Acme"), listA.text);
check("Team B: list_people shows only its founder", /^1 connector\(s\)/.test(listB.text) && !listB.text.includes("Alex"), listB.text);
const homeList = await tool(homeKey, "list_people");
check("Home: list_people shows no team members", !homeList.text.includes("Founder") && !homeList.text.includes("Alex"), homeList.text);

// Deletion: a home admin deletes both teams, which also cleans up after the run.
const homeTools = (await rpc(homeKey, "tools/list", {})).result.tools.map((t) => t.name);
const left = [];
if (homeTools.includes("delete_team")) {
  for (const t of [a, b]) {
    const keys = [t.key, ...(t === a && mate ? [mate] : [])];
    const preview = await tool(homeKey, "delete_team", { team: t.team });
    check(`Home: delete_team previews ${t.label}`, preview.text.includes(`tm-${t.team}-${slug}`) && preview.text.includes(`confirm`), preview.text);
    const done = await tool(homeKey, "delete_team", { team: t.team, confirm: t.team });
    check(`Home: delete_team deletes ${t.label}`, !done.error && done.text.startsWith("Deleted"), done.text);
    for (const key of keys) {
      const after = await rpc(key, "tools/call", { name: "whoami", arguments: {} }).then((r) => JSON.stringify(r), (err) => `refused: ${err.message}`);
      check(`${t.label}: a deleted team's key stops working (and starts no new team)`, after.startsWith("refused"), after);
    }
    const gone = await tool(homeKey, "delete_team", { team: t.team });
    check(`Home: ${t.label} is gone from the registry`, gone.error && /No team/.test(gone.text), gone.text);
  }
  for (const t of [a, b].filter((t) => t.media)) {
    const status = (await fetch(t.media)).status;
    check(`${t.label}: its uploaded file is gone`, status === 404, status);
  }
} else {
  left.push(...[a, b].map((t) => t.team));
  console.log("(The home key isn't an admin, so the teams weren't deleted.)");
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
if (left.length) console.log(`Teams left to delete (delete_team, as a home admin): ${left.join(" ")}`);
process.exit(failed ? 1 : 0);
