// End-to-end walk through every tool, as two people would use event-hog,
// against a running server with SELF_SERVE="teams" (wrangler dev):
//
//   node scripts/simulate-users.mjs <base-url> <home-admin-key> [log-file]
//
// Maya copies the landing page's prompt (a fresh key), starts a team, sets up
// an event, preps, logs people, captures slides, drafts posts, syncs the CRM,
// and invites Dev. Dev joins with the URL add_person gives, logs the same
// contact, fixes and removes contacts with Maya (and clones a copy with git),
// and is then removed. Every response goes to the log file; checks
// print PASS/FAIL. The home admin key deletes the team at the end.

import { writeFileSync, appendFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base = "http://localhost:8799", homeKey, logFile = "/tmp/eh-sim.log"] = process.argv.slice(2);
if (!homeKey) {
  console.error("Usage: node scripts/simulate-users.mjs <base-url> <home-admin-key> [log-file]");
  process.exit(2);
}
writeFileSync(logFile, "");
const log = (s) => appendFileSync(logFile, s + "\n");

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let id = 0;
async function rpc(key, method, params) {
  const res = await fetch(`${base}/mcp/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) return { httpStatus: res.status, text: await res.text() };
  return res.json();
}

const used = new Set();
async function tool(who, name, args = {}) {
  used.add(name);
  const t0 = Date.now();
  const out = await rpc(who.key, "tools/call", { name, arguments: args });
  const ms = Date.now() - t0;
  let text, error;
  if (out.httpStatus) (text = `HTTP ${out.httpStatus}: ${out.text}`), (error = true);
  else if (out.error) (text = `RPC error: ${out.error.message}`), (error = true);
  else (text = out.result.content.map((c) => c.text ?? `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`).join("\n")), (error = !!out.result.isError);
  log(`\n===== ${who.name} → ${name} ${JSON.stringify(args).slice(0, 300)}  (${ms} ms${error ? ", ERROR" : ""})\n${text}`);
  return { text, error, ms, raw: out };
}

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n     ${String(detail).slice(0, 400).replace(/\n/g, "\n     ")}`}`);
}

// ---------------------------------------------------------------- Maya: connect
const maya = { name: "Maya", key: hex(24) };

const landing = await fetch(`${base}/`);
check("Landing page serves the copy-a-prompt page", landing.ok && (await landing.text()).includes("Copy this prompt"));
const browser = await fetch(`${base}/mcp/${maya.key}`, { headers: { accept: "text/html" } });
check("Opening a connector link in a browser explains it", browser.ok && (await browser.text()).includes("connector link"));

const init = await rpc(maya.key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sim", version: "1" } });
check("initialize returns server info and instructions", init.result?.serverInfo?.name === "event-hog" && init.result?.instructions?.length > 500, JSON.stringify(init).slice(0, 300));
const notif = await fetch(`${base}/mcp/${maya.key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
check("notifications/initialized gets 202", notif.status === 202, notif.status);
const list = await rpc(maya.key, "tools/list", {});
const toolNames = list.result.tools.map((t) => t.name);
check("A team founder sees the tools (no operator delete_team)", toolNames.length >= 50 && !toolNames.includes("delete_team"), toolNames.length);
const prompts = await rpc(maya.key, "prompts/list", {});
check("prompts/list lists prompts", prompts.result?.prompts?.length > 3, JSON.stringify(prompts).slice(0, 200));
for (const p of prompts.result.prompts) {
  const got = await rpc(maya.key, "prompts/get", { name: p.name });
  if (!got.result?.messages?.[0]?.content?.text) check(`prompts/get ${p.name}`, false, JSON.stringify(got));
}
check(`prompts/get works for all ${prompts.result.prompts.length} prompts`, true);
log(`\nPROMPTS: ${prompts.result.prompts.map((p) => p.name).join(", ")}`);

let r = await tool(maya, "whoami");
check("Maya: fresh key is a guest admin of her own team", /no name yet/.test(r.text) && /admin/.test(r.text), r.text);

// get_started with nothing: should ask the questions.
r = await tool(maya, "get_started");
check("get_started (empty) asks company, conference, name", /company/i.test(r.text) && /conference/i.test(r.text) && /name/i.test(r.text) && !r.error, r.text);

// Answers, but no workspace for the conference yet.
r = await tool(maya, "get_started", { company: "Lumen Robotics", conference: "RoboBuild Expo 2026", name: "Maya Chen", email: "maya@lumenrobotics.test", company_url: "https://lumenrobotics.test" });
check("get_started with answers says to set up the event", /no EventHog workspace yet/.test(r.text) && /new_event/.test(r.text), r.text);

r = await tool(maya, "whoami");
check("Maya: whoami now has her name and team name", r.text.includes("Maya Chen") && r.text.includes("Lumen Robotics' team"), r.text);

// Today is during the event.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const plus = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
r = await tool(maya, "new_event", {
  name: "RoboBuild Expo 2026", short_name: "RoboBuild Expo", starts_on: plus(today, -1), ends_on: plus(today, 1),
  time_zone: "America/Chicago", city: "Austin, TX", venue: "Austin Convention Center", website: "https://robobuild.test",
  organizer: "RoboBuild Inc", series: "RoboBuild Expo", cadence: "annual", why: "Meet warehouse automation buyers.",
});
const slug = r.text.match(/Started (\S+?)[.:\s]/)?.[1];
check("new_event starts a workspace", !r.error && !!slug, r.text);
const E = { event: slug };

r = await tool(maya, "get_started", { conference: "RoboBuild Expo" });
check("get_started finds the event and says DURING", /PHASE: DURING/.test(r.text), r.text);
r = await tool(maya, "get_started", { conference: "robobuild.test" });
check("get_started matches the event by website", /PHASE: DURING/.test(r.text), r.text);
r = await tool(maya, "get_started", { conference: slug, phase: "before" });
check("get_started phase=before gives the prep playbook", /PHASE: BEFORE/.test(r.text) && /Ideal customer/.test(r.text), r.text);
r = await tool(maya, "get_started", { conference: slug, phase: "after" });
check("get_started phase=after gives the follow-up playbook", /PHASE: AFTER/.test(r.text), r.text);

r = await tool(maya, "save_my_profile", { ideal_customer: "Ops and automation leads at 3PLs and e-commerce warehouses" });
check("save_my_profile saves the ideal customer", !r.error && /ideal_customer/.test(r.text), r.text);
r = await tool(maya, "save_my_profile", { email: "not-an-email" });
check("save_my_profile rejects a bad email", r.error, r.text);

for (const phase of ["before", "during", "after"]) {
  r = await tool(maya, "what_can_i_do", { phase, ...E });
  check(`what_can_i_do (${phase}) gives a menu`, !r.error && r.text.length > 200, r.text);
}

// ---------------------------------------------------------------- workspace basics
r = await tool(maya, "list_events");
check("list_events shows the new event as current", r.text.includes(slug) && /current/.test(r.text), r.text);
r = await tool(maya, "event_brief");
check("event_brief (no event arg) uses the current event", !r.error && /Contacts logged: 0/.test(r.text), r.text);
r = await tool(maya, "list_files", E);
check("list_files shows the template", r.text.includes("README.md") && r.text.includes("prep/event.md"), r.text);
r = await tool(maya, "read_file", { path: "prep/event.md", ...E });
check("read_file reads prep/event.md", r.text.includes("RoboBuild"), r.text);
r = await tool(maya, "read_file", { path: "../../etc/passwd", ...E });
check("read_file refuses path traversal", r.error, r.text);
r = await tool(maya, "read_file", { path: "nope.md", ...E });
check("read_file on a missing file errors helpfully", r.error && /list_files/.test(r.text), r.text);

// ---------------------------------------------------------------- before: prep
r = await tool(maya, "save_attendees", {
  attendees_csv: 'name,title,company\nPriya Raman,VP Operations,ShipFast Logistics\nTom Becker,"Director, Automation",CartCo\nLena Ortiz,CTO,Boxly\n',
  companies_csv: "company,attendees\nShipFast Logistics,1\nCartCo,1\nBoxly,1\n",
  coverage: "Speaker and exhibitor pages only.", source: "robobuild.test exhibitor list", ...E,
});
check("save_attendees saves 3 attendees", !r.error && /3 attendee/.test(r.text), r.text);
r = await tool(maya, "save_attendees", { attendees_csv: "foo,bar\n1,2\n", ...E });
check("save_attendees rejects a CSV with no name column", r.error, r.text);

r = await tool(maya, "enrich_people", { people: [{ name: "Priya Raman", company: "ShipFast Logistics" }] });
check("enrich_people tells a team to use web search instead", /web search|deploy your own/i.test(r.text), r.text);

r = await tool(maya, "save_targets", {
  targets: [
    { name: "Priya Raman", company: "ShipFast Logistics", title: "VP Operations", priority: "A", role: "buyer", why: "Runs 12 warehouses; picking labor is their top cost.", how_to_spot: "Panel at 2pm" },
    { name: "Tom Becker", company: "CartCo", title: "Director, Automation", priority: "b", role: "champion", why: "Piloting AMRs this year." },
    { name: "Lena Ortiz", company: "Boxly", title: "CTO", priority: "C", why: "Possible integration partner." },
  ], ...E,
});
check("save_targets saves 3 targets (lowercase priority ok)", !r.error && /3 target/.test(r.text), r.text);
r = await tool(maya, "save_targets", { targets: [{ name: "X", priority: "Z", why: "y" }], ...E });
check("save_targets rejects priority Z", r.error, r.text);
r = await tool(maya, "targets", E);
check("targets lists 3, none met", /0 of 3 met/.test(r.text), r.text);

r = await tool(maya, "list_skills");
const skills = [...r.text.matchAll(/^- \**`?([a-z0-9-]+)/gm)].map((m) => m[1]);
check("list_skills lists the kit skills", skills.length >= 6, r.text);
for (const s of skills) {
  const got = await tool(maya, "get_skill", { name: s });
  check(`get_skill ${s}`, !got.error && got.text.length > 300, got.text.slice(0, 200));
}
r = await tool(maya, "get_skill", { name: "no-such-skill" });
check("get_skill on an unknown skill errors", r.error, r.text);
r = await tool(maya, "set_my_research_tools", { tools: [{ name: "Claude web search", use_for: "everything" }] });
check("set_my_research_tools saves", !r.error, r.text);
r = await tool(maya, "get_config", { skill: "augment-speakers-panelists" });
check("get_config returns her research tools", r.text.includes("Claude web search"), r.text);

r = await tool(maya, "save_speaker_profile", {
  name: "Priya Raman", organization: "ShipFast Logistics", title: "VP Operations", session: "Scaling the Warehouse", session_time: "2pm",
  why: "Target buyer.", identity_confidence: "high", socials: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/priya-raman-test" }],
  features: [{ date: "2026-05-01", outlet: "Supply Chain Dive", title: "ShipFast automates", url: "https://example.com/shipfast" }], ...E,
});
check("save_speaker_profile saves speakers/…", !r.error && /speakers\//.test(r.text), r.text);

r = await tool(maya, "save_flash_cards", {
  cards: [
    { term: "AMR", expansion: "Autonomous Mobile Robot", definition: "A robot that navigates a warehouse on its own, without fixed tracks.", category: "acronym" },
    { term: "3PL", expansion: "Third-Party Logistics", definition: "A company that runs warehousing and shipping for other companies.", category: "acronym" },
  ], ...E,
});
check("save_flash_cards saves 2 cards", !r.error, r.text);
r = await tool(maya, "save_flash_cards", { cards: [{ term: "AMR", definition: "dup" }], ...E });
check("save_flash_cards doesn't duplicate an existing term", !r.error && !/2 new|Added 1/.test(r.text), r.text);
r = await tool(maya, "flash_cards", E);
check("flash_cards reads the deck", r.text.includes("AMR") && r.text.includes("3PL"), r.text);
r = await tool(maya, "flash_cards", { format: "csv", ...E });
check("flash_cards csv export", /Front,Back/i.test(r.text), r.text);

r = await tool(maya, "save_draft", { kind: "thread", title: "We're at RoboBuild", posts: ["Heading to RoboBuild Expo in Austin this week.", "Come find us at booth [gap]."], status: "draft", ...E });
const draftPath = r.text.match(/drafts\/\S+\.md/)?.[0];
check("save_draft saves a thread", !r.error && !!draftPath, r.text);
r = await tool(maya, "add_to_draft", { path: draftPath, text: "Priya said picking labor is 60% of cost.", section: "Material", from: "contacts/…", ...E });
check("add_to_draft appends material", !r.error, r.text);
r = await tool(maya, "add_to_draft", { path: draftPath, status: "posted", ...E });
check("add_to_draft refuses 'posted' without a URL", r.error, r.text);
r = await tool(maya, "drafts", E);
check("drafts lists the draft", draftPath && r.text.includes(draftPath), r.text);

// ---------------------------------------------------------------- during: log people
r = await tool(maya, "search", { query: "Priya", ...E });
check("search before logging finds Priya in prep", r.text.includes("prep/"), r.text);
r = await tool(maya, "log_contact", {
  name: "Priya Raman", company: "ShipFast Logistics", title: "VP Operations", email: "priya@shipfast.test", phone: "(512) 555-0142",
  priority: "A", where_met: "After her panel", notes: "Picking labor is their top cost. Interested in a pilot at the Dallas site.",
  follow_up: "Maya sends the pilot one-pager by Friday", based_in: "Dallas", ...E,
});
const priyaPath = r.text.match(/contacts\/\S+\.md/)?.[0];
check("log_contact creates Priya", /New contact/.test(r.text) && !!priyaPath, r.text);
r = await tool(maya, "log_contact", { name: "Priya Raman", email: "PRIYA@shipfast.test", title: "SVP Ops", notes: "Ran into her at the coffee line; wants pricing.", ...E });
check("log_contact by same email appends, doesn't overwrite title", /existing contact/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: priyaPath, ...E });
check("Priya's file keeps the first title and has 2 touchpoints", r.text.includes("VP Operations") && !r.text.includes("SVP Ops") && (r.text.match(/^### /gm) ?? []).length === 2, r.text);
r = await tool(maya, "log_contact", { name: "Sam Wu", company: "Boxly", notes: "Engineer, curious about our SDK.", where_met: "Booth", ...E });
check("log_contact creates Sam with only name/company/notes", /New contact/.test(r.text), r.text);
r = await tool(maya, "log_contact", { name: "Maya teammate", email: "maya@lumenrobotics.test", notes: "me", ...E });
check("log_contact refuses a teammate's email", r.error, r.text);
r = await tool(maya, "log_contact", { name: "No notes" , ...E });
check("log_contact without notes errors", r.error, r.text);
r = await tool(maya, "targets", { status: "not_met", ...E });
check("targets not_met drops Priya after she's logged", !r.text.includes("Priya") && r.text.includes("Tom Becker"), r.text);

r = await tool(maya, "add_note", { title: "Panel: Scaling the Warehouse", body: "Everyone is talking about labor costs and AMR fleet mgmt.", kind: "session", ...E });
check("add_note saves a session note", !r.error && /notes\//.test(r.text), r.text);
r = await tool(maya, "append_to_file", { path: "prep/targets.md", text: "Met Priya after the panel.", ...E });
check("append_to_file appends to prep/targets.md", !r.error, r.text);
r = await tool(maya, "append_to_file", { path: "prep/nope.md", text: "x", ...E });
check("append_to_file won't create files", r.error, r.text);
r = await tool(maya, "recent_activity", { limit: 5, ...E });
check("recent_activity shows Maya's commits", r.text.includes("Maya Chen"), r.text);

// Slides: camera page, upload link, notes.
r = await tool(maya, "slide_capture_link", { session: "Scaling the Warehouse", ...E });
const capture = r.text.match(/(https?:\/\/\S+\/capture\/[a-f0-9]{32}\S*)/)?.[1]?.replace(/[).,]+$/, "");
check("slide_capture_link gives a camera page", !!capture, r.text);
let slidePath;
if (capture) {
  const page = await fetch(capture, { headers: { accept: "text/html" } });
  const html = await page.text();
  check("Camera page opens with her name", page.ok && html.includes("Maya Chen"), html.slice(0, 200));
  const form = new FormData();
  form.set("event", slug);
  form.set("session", "Scaling the Warehouse");
  form.append("slide", new Blob([JPEG], { type: "image/jpeg" }), "slide.jpg");
  form.set("meta", "[]");
  const res = await fetch(capture.split("?")[0], { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  log(`\n===== Maya → POST capture page\n${JSON.stringify(body)}`);
  slidePath = body.saved?.[0];
  check("Camera page saves a slide", res.ok && !!slidePath, JSON.stringify(body));
}
r = await tool(maya, "upload_link", { kind: "slide", filename: "slide2.jpg", session: "Scaling the Warehouse", note: "The cost chart", ...E });
const uploadUrl = r.text.match(/'(https?:\/\/[^']+\/upload\/[^']+)'/)?.[1];
check("upload_link gives a one-time URL", !!uploadUrl, r.text);
if (uploadUrl) {
  const up = await fetch(uploadUrl, { method: "PUT", body: JPEG });
  const upBody = await up.json().catch(() => ({}));
  log(`\n===== Maya → PUT upload\n${JSON.stringify(upBody)}`);
  check("Upload accepts a JPEG", up.ok, JSON.stringify(upBody));
  const again = await fetch(uploadUrl, { method: "PUT", body: JPEG });
  check("Upload link is single use", !again.ok, again.status);
}
r = await tool(maya, "upload_link", { kind: "badge", filename: "badge.png", ...E });
const badgeUrl = r.text.match(/'(https?:\/\/[^']+\/upload\/[^']+)'/)?.[1];
if (badgeUrl) {
  const bad = await fetch(badgeUrl, { method: "PUT", body: JPEG });
  check("Upload refuses bytes that don't match the extension (jpeg sent as .png)", !bad.ok, bad.status);
}
r = await tool(maya, "slides", { needs_notes: true, ...E });
check("slides lists slides needing notes", slidePath ? r.text.includes(slidePath) : false, r.text);
if (slidePath) {
  r = await tool(maya, "view_slide", { path: slidePath, ...E });
  check("view_slide returns the image", !r.error && r.raw?.result?.content?.some((c) => c.type === "image"), r.text);
  r = await tool(maya, "save_slide_notes", {
    path: slidePath, slide_type: "data_chart", title: "Labor is 60% of fulfillment cost", core_message: "Picking labor dominates warehouse cost.",
    layout: "Single bar chart, title top-left, callout right.", transcript: "H1: Labor is 60% of fulfillment cost\nChart label: Labor 60%, Rent 20%, Other 20%",
    metrics: { Labor: "60%" }, alt: "Bar chart: labor 60%, rent 20%, other 20%.", transcription_fidelity: "verbatim", speaker: "Priya Raman", ...E,
  });
  check("save_slide_notes writes notes", !r.error, r.text);
  r = await tool(maya, "add_field_note", { path: slidePath, note: "She said this number is from 2025.", ...E });
  check("add_field_note adds a note", !r.error, r.text);
  r = await tool(maya, "slides", { needs_notes: true, ...E });
  check("slide no longer needs notes", !r.text.includes(slidePath), r.text);
}

// Brand.
r = await tool(maya, "get_design_system");
check("get_design_system with none says how to make one", !r.text.includes("Unknown tool"), r.text);
r = await tool(maya, "extract_brand", { url: "https://example.com" });
check("extract_brand reads a site", !r.error, r.text);
const DESIGN = `---\nname: Lumen\ncolors:\n  primary: "#5B21B6"\n---\n# Lumen\n\n## Overview\nCalm, technical.\n\n## Colors\nPrimary #5B21B6.\n\n## Typography\nInter.\n\n## Layout\n12-col.\n\n## Elevation & Depth\nFlat.\n\n## Shapes\n8px radius.\n\n## Components\nButtons.\n\n## Do's and Don'ts\nDo keep it simple.\n`;
r = await tool(maya, "save_design_system", { brand: "lumen", markdown: DESIGN, why: "drafted for test" });
check("save_design_system saves", !r.error, r.text);
r = await tool(maya, "get_design_system", { brand: "lumen" });
check("get_design_system returns it", r.text.includes("#5B21B6"), r.text);
if (slidePath) {
  const html = `<!doctype html><html><head><style>body{width:1920px;height:1080px;background:#5B21B6;color:#fff}</style></head><body><h1>Labor is 60% of fulfillment cost</h1><p>Source: Priya Raman, Scaling the Warehouse, RoboBuild Expo 2026</p></body></html>`;
  r = await tool(maya, "save_recreated_slide", { path: slidePath, brand: "lumen", html, ...E });
  const pub = r.text.match(/https?:\/\/\S+\/media\/\S+\.html/)?.[0];
  check("save_recreated_slide saves and publishes", !r.error && !!pub, r.text);
  if (pub) {
    const page = await fetch(pub);
    check("Published slide is served with a CSP sandbox", page.ok && /sandbox/.test(page.headers.get("content-security-policy") ?? ""), [...page.headers].join(" "));
  }
  r = await tool(maya, "save_recreated_slide", { path: slidePath, brand: "lumen", html: html.replace("</body>", "<script>alert(1)</script></body>"), ...E });
  check("save_recreated_slide refuses <script>", r.error, r.text);
  r = await tool(maya, "save_recreated_slide", { path: slidePath, brand: "lumen", html: "<html><body><h1>No credit</h1></body></html>", ...E });
  check("save_recreated_slide refuses a slide with no credit", r.error, r.text);
}

// Structured CRM.
r = await tool(maya, "query_crm", { sql: "SELECT p.name, o.complete_name FROM persons p LEFT JOIN affiliations a ON a.person_id = p.id LEFT JOIN organizations o ON o.id = a.org_id ORDER BY p.name" });
check("query_crm lists people and orgs", r.text.includes("Priya Raman") && r.text.includes("ShipFast"), r.text);
r = await tool(maya, "query_crm", { sql: "DELETE FROM persons" });
check("query_crm refuses writes", r.error, r.text);
r = await tool(maya, "relate_orgs", { org: "Boxly", other_org: "ShipFast Logistics", kind: "partners_with", source: "Sam at the booth" });
check("relate_orgs records a relationship", !r.error, r.text);
r = await tool(maya, "define_location", { name: "Texas", kind: "state" });
check("define_location Texas", !r.error, r.text);
r = await tool(maya, "define_location", { name: "Dallas", kind: "city", part_of: ["Texas"] });
check("define_location Dallas part of Texas", !r.error, r.text);
r = await tool(maya, "link_location", { subject_type: "person", subject: "priya@shipfast.test", location: "Dallas", role: "based_in" });
check("link_location Priya → Dallas", !r.error, r.text);
r = await tool(maya, "who_is_in", { location: "Texas" });
check("who_is_in Texas finds Priya (nested)", r.text.includes("Priya"), r.text);

// ---------------------------------------------------------------- team: invite Dev
r = await tool(maya, "list_people");
check("list_people shows just Maya", /^1 connector/.test(r.text), r.text);
r = await tool(maya, "add_person", { name: "Dev Patel", email: "dev@lumenrobotics.test" });
const devKey = r.text.match(/\/mcp\/([a-f0-9]{48})/)?.[1];
check("add_person returns Dev's connector URL", !!devKey, r.text);
r = await tool(maya, "add_person", { name: "Dev Again", email: "DEV@lumenrobotics.test" });
check("add_person refuses the same email twice", r.error, r.text);
r = await tool(maya, "add_person", { name: "Bad", email: "nope" });
check("add_person refuses a bad email", r.error, r.text);

const dev = { name: "Dev", key: devKey };
await rpc(dev.key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sim", version: "1" } });
r = await tool(dev, "whoami");
check("Dev: whoami says Dev Patel on Lumen's team, not admin", r.text.includes("Dev Patel") && r.text.includes("Lumen Robotics' team") && !/You're an admin/.test(r.text), r.text);
r = await tool(dev, "get_started", { conference: "RoboBuild" });
check("Dev: get_started takes the team's company and finds the event, DURING", /PHASE: DURING/.test(r.text) && r.text.includes("Dev Patel (Lumen Robotics)"), r.text);
r = await tool(dev, "event_brief");
check("Dev: event_brief sees Maya's 2 contacts", /Contacts logged: 2/.test(r.text), r.text);
r = await tool(dev, "search", { query: "pilot", ...E });
check("Dev: search finds Maya's notes on Priya", r.text.includes(priyaPath ?? "contacts/"), r.text);
r = await tool(dev, "log_contact", { name: "Priya Raman", company: "ShipFast Logistics", notes: "Talked integrations with her team lead.", follow_up: "Dev intros our CTO", ...E });
check("Dev: logging Priya again appends to the same file", /existing contact/.test(r.text) && r.text.includes(priyaPath ?? "@@"), r.text);
r = await tool(dev, "log_contact", { name: "Tom Becker", company: "CartCo", notes: "Wants an AMR demo.", priority: "A", ...E });
check("Dev: logs target Tom", /New contact/.test(r.text), r.text);
r = await tool(dev, "targets", E);
check("targets shows 2 of 3 met, Tom met by Dev", /2 of 3 met/.test(r.text) && /Tom Becker.*met by Dev Patel/.test(r.text), r.text);
r = await tool(dev, "add_person", { name: "Nope", email: "nope@lumenrobotics.test" });
check("Dev can't invite (not admin)", r.error, r.text);
r = await tool(dev, "remove_person", { email: "maya@lumenrobotics.test" });
check("Dev can't remove Maya", r.error, r.text);
r = await tool(dev, "recent_activity", { limit: 5, ...E });
check("recent_activity shows both people", r.text.includes("Dev Patel") && r.text.includes("Maya Chen"), r.text);

// ---------------------------------------------------------------- after: CRM
r = await tool(maya, "contacts_csv", E);
check("contacts_csv has 3 rows with E.164 phone", (r.text.match(/\ncontacts\//g) ?? []).length === 0 && /\+15125550142/.test(r.text) && r.text.includes("Tom Becker"), r.text);
r = await tool(maya, "crm_queue", E);
check("crm_queue lists 3 pending contacts", /3 contact\(s\)/.test(r.text), r.text);
r = await tool(maya, "crm_queue", { met_by: ["me"], ...E });
check("crm_queue met_by me: Priya and Sam only", r.text.includes("Priya") && r.text.includes("Sam") && !r.text.includes("Tom Becker"), r.text);
r = await tool(maya, "crm_queue", { met_by: ["Dev"], ...E });
check("crm_queue met_by Dev: Priya and Tom", r.text.includes("Priya") && r.text.includes("Tom") && !r.text.includes("Sam Wu"), r.text);
r = await tool(maya, "crm_queue", { met_by: ["Nobody"], ...E });
check("crm_queue met_by an unknown name errors with the roster", r.error && /Maya Chen/.test(r.text), r.text);
r = await tool(maya, "export_hubspot_csv", E);
check("export_hubspot_csv writes exports/…csv", !r.error && /exports\/hubspot-contacts/.test(r.text) && r.text.includes("maya@lumenrobotics.test") && r.text.includes("+15125550142"), r.text);
r = await tool(maya, "mark_crm_synced", { path: priyaPath, hubspot_id: "1001", ...E });
check("mark_crm_synced marks Priya", !r.error, r.text);
r = await tool(maya, "crm_queue", E);
const tps = [...r.text.matchAll(/touchpoint ([0-9a-f-]{36}) · with Priya/g)].map((m) => m[1]);
check("crm_queue now: 2 contacts pending, Priya's conversations listed", /2 contact\(s\)/.test(r.text) && tps.length >= 1, r.text);
if (tps.length) {
  r = await tool(maya, "mark_touchpoints_synced", { touchpoints: tps.map((t, i) => ({ id: t, activity_id: `m${i}`, task_id: `t${i}` })), ...E });
  check("mark_touchpoints_synced records them", !r.error, r.text);
  r = await tool(maya, "crm_queue", E);
  check("crm_queue no longer lists Priya's conversations", !/with Priya/.test(r.text), r.text);
}
r = await tool(maya, "mark_touchpoints_synced", { touchpoints: [{ id: "bogus", activity_id: "x" }], ...E });
check("mark_touchpoints_synced rejects an unknown id", r.error, r.text);

// ---------------------------------------------------------------- harder cases
// A full-size roster, saved over the first one.
const roster = ["name,title,company", ...Array.from({ length: 500 }, (_, i) => `Attendee ${i + 1},"Director, Ops ${i % 7}",Company ${i % 40}`)].join("\n");
r = await tool(maya, "save_attendees", { attendees_csv: roster, source: "full directory export", ...E });
check("save_attendees takes a 500-person roster", !r.error && /500 attendee/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: "prep/attendees.csv", ...E });
check("A new roster replaces the old one (501 lines, Priya gone)", r.text.trim().split("\n").length === 501 && !r.text.includes("Priya"), r.text.slice(0, 200));

// Same name, different companies: two people, two files.
r = await tool(maya, "log_contact", { name: "Alex Kim", company: "CartCo", notes: "Ops manager at CartCo.", ...E });
const alex1 = r.text.match(/contacts\/\S+\.md/)?.[0];
r = await tool(maya, "log_contact", { name: "Alex Kim", company: "Boxly", notes: "Different Alex, works at Boxly.", ...E });
const alex2 = r.text.match(/contacts\/\S+\.md/)?.[0];
check("Same name at two companies makes two contacts", /New contact/.test(r.text) && alex1 && alex2 && alex1 !== alex2, `${alex1} ${alex2}`);
r = await tool(maya, "log_contact", { name: "Alex Kim", notes: "Which Alex? No company given.", ...E });
check("Same name with no company doesn't get glued onto one of them", /New contact/.test(r.text) || r.error, r.text);

// Accents, apostrophes, long voice-memo notes.
const memo = "Voice memo: ".concat("We talked about pallet flow, pick rates, and how they staff peak season. ".repeat(40));
r = await tool(maya, "log_contact", { name: "José Núñez-O'Brien", company: "Señor Freight", notes: memo, ...E });
const jose = r.text.match(/contacts\/\S+\.md/)?.[0];
check("Accented name gets a clean file name", /New contact/.test(r.text) && jose === "contacts/jose-nunez-o-brien--senor-freight.md", r.text);
r = await tool(maya, "read_file", { path: jose, ...E });
check("Accented name and the full long note are kept as written", r.text.includes("José Núñez-O'Brien") && r.text.includes(memo.trim()), r.text.slice(0, 300));
r = await tool(maya, "search", { query: "Núñez", ...E });
check("Search finds the accented name", r.text.includes(jose ?? "@@"), r.text);

// Both people logging at the same moment.
const burst = await Promise.all([
  tool(maya, "log_contact", { name: "Rush One", company: "Alpha", notes: "Burst 1", ...E }),
  tool(dev, "log_contact", { name: "Rush Two", company: "Beta", notes: "Burst 2", ...E }),
  tool(maya, "log_contact", { name: "Rush Three", company: "Gamma", notes: "Burst 3", ...E }),
  tool(dev, "log_contact", { name: "Rush Four", company: "Delta", notes: "Burst 4", ...E }),
]);
check("4 contacts logged at once all save", burst.every((x) => !x.error && /New contact/.test(x.text)), burst.map((x) => x.text.split("\n")[0]).join(" | "));
const same = await Promise.all([
  tool(maya, "log_contact", { name: "Jordan Lee", company: "Omega", notes: "Maya's take on Jordan", ...E }),
  tool(dev, "log_contact", { name: "Jordan Lee", company: "Omega", notes: "Dev's take on Jordan", ...E }),
]);
check("Both logging the same new person at once both save", same.every((x) => !x.error), same.map((x) => x.text.split("\n")[0]).join(" | "));
r = await tool(maya, "read_file", { path: "contacts/jordan-lee--omega.md", ...E });
check("…into one file with both conversations", r.text.includes("Maya's take") && r.text.includes("Dev's take"), r.text);
r = await tool(maya, "query_crm", { sql: "SELECT count(*) AS n FROM persons WHERE name = 'Jordan Lee'" });
check("…and one person in the database", /"n": 1\b/.test(r.text), r.text);
r = await tool(maya, "contacts_csv", E);
check("The contacts CSV has every one of them", ["Rush One", "Rush Two", "Rush Three", "Rush Four", "Jordan Lee", "José Núñez-O'Brien"].every((n) => r.text.includes(n)) && (r.text.match(/Jordan Lee/g) ?? []).length === 1, r.text);

// ---------------------------------------------------------------- fixing mistakes
// A wrong email on a contact already in HubSpot.
r = await tool(maya, "correct_contact", { path: priyaPath, email: "priya.raman@shipfast.test", reason: "verified in HubSpot", ...E });
check("correct_contact fixes an email and says to update HubSpot too", !r.error && /HubSpot \(1001\)/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: priyaPath, ...E });
check("…the file has the new email and a line with the old one", /email: "priya\.raman@shipfast\.test"/.test(r.text) && /Corrected email from "priya@shipfast\.test" to "priya\.raman@shipfast\.test" \(verified in HubSpot\)/.test(r.text), r.text);
r = await tool(maya, "contacts_csv", E);
check("…the CSV has the new email", r.text.includes("priya.raman@shipfast.test") && !r.text.includes("priya@shipfast.test"), r.text);
r = await tool(maya, "query_crm", { sql: "SELECT value FROM person_identifiers WHERE kind = 'email' AND value LIKE 'priya%'" });
check("…and the database swapped the identifier", r.text.includes("priya.raman@shipfast.test") && !r.text.includes('"priya@shipfast.test"'), r.text);

// A misspelled name: the file follows the name.
r = await tool(maya, "correct_contact", { path: "contacts/sam-wu--boxly.md", name: "Samantha Wu", reason: "her badge says Samantha", ...E });
check("correct_contact renames the file when the name changes", !r.error && r.text.includes("contacts/samantha-wu--boxly.md") && /renamed from contacts\/sam-wu--boxly\.md/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: "contacts/sam-wu--boxly.md", ...E });
check("…the old file is gone", r.error, r.text);
r = await tool(maya, "read_file", { path: "contacts/samantha-wu--boxly.md", ...E });
check("…the heading has the new name", /^# Samantha Wu · Boxly$/m.test(r.text) && /name: "Samantha Wu"/.test(r.text), r.text);
r = await tool(maya, "log_contact", { name: "Samantha Wu", company: "Boxly", notes: "Second chat about the SDK.", ...E });
check("…and logging the corrected name adds to the same contact", /existing contact/.test(r.text) && r.text.includes("contacts/samantha-wu--boxly.md"), r.text);
r = await tool(maya, "query_crm", { sql: "SELECT p.name, i.artifact_path FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id JOIN persons p ON p.id = ip.person_id WHERE p.name LIKE 'Sam%'" });
check("…with one person in the database, renamed, and both conversations on the new file", (r.text.match(/samantha-wu--boxly\.md/g) ?? []).length === 2 && !r.text.includes("sam-wu--boxly") && !/"Sam Wu"/.test(r.text), r.text);

r = await tool(maya, "correct_contact", { path: alex1, company: "Boxly", reason: "test", ...E });
check("correct_contact refuses a rename onto another contact", r.error && /same person/.test(r.text), r.text);
r = await tool(maya, "correct_contact", { path: "contacts/tom-becker--cartco.md", priority: "A", reason: "test", ...E });
check("correct_contact refuses when nothing changes", r.error && /Nothing to correct/.test(r.text), r.text);
r = await tool(maya, "correct_contact", { path: "contacts/tom-becker--cartco.md", title: "VP Automation", ...E });
check("correct_contact needs a reason", r.error, r.text);

// A copy for Obsidian, refreshed after a removal below.
r = await tool(maya, "clone_link", E);
const cloneCmd = r.text.match(/^First time:\s+(.+)$/m)?.[1];
const pullCmd = r.text.match(/^To refresh:\s+(.+)$/m)?.[1];
check("clone_link gives a clone command, a refresh command and the Obsidian step", !!cloneCmd && !!pullCmd && /Obsidian/.test(r.text), r.text);
const copyDir = mkdtempSync(join(tmpdir(), "eh-copy-"));
let cloned = false;
try {
  execSync(cloneCmd, { cwd: copyDir, stdio: "pipe" });
  cloned = existsSync(join(copyDir, slug, "contacts", "samantha-wu--boxly.md")) && existsSync(join(copyDir, slug, "contacts", "rush-one--alpha.md"));
} catch (err) {
  log(`clone failed: ${err.stderr ?? err}`);
}
check("…the clone command downloads the workspace", cloned, copyDir);

// Removing someone who wasn't met.
r = await tool(maya, "remove_contact", { path: "contacts/rush-one--alpha.md", ...E });
check("remove_contact without confirm only previews", !r.error && /1 conversation\(s\), logged by Maya Chen/.test(r.text) && /confirm/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: "contacts/rush-one--alpha.md", ...E });
check("…and the file is still there", !r.error, r.text);
r = await tool(maya, "remove_contact", { path: "contacts/rush-one--alpha.md", confirm: "contacts/rush-one--alpha.md", ...E });
check("remove_contact needs a reason", r.error, r.text);
r = await tool(maya, "remove_contact", { path: "contacts/rush-one--alpha.md", confirm: "contacts/rush-one--alpha.md", reason: "logged by mistake", ...E });
check("remove_contact with confirm removes it", !r.error && /Removed Rush One/.test(r.text) && /removed 1 conversation/.test(r.text), r.text);
r = await tool(maya, "read_file", { path: "contacts/rush-one--alpha.md", ...E });
check("…the file is gone", r.error, r.text);
r = await tool(maya, "query_crm", { sql: "SELECT count(*) AS n FROM interactions WHERE artifact_path = 'contacts/rush-one--alpha.md'" });
check("…and its conversation left the database", /"n": 0\b/.test(r.text), r.text);
let refreshed = false;
if (cloned) {
  try {
    execSync(pullCmd, { cwd: copyDir, stdio: "pipe" });
    refreshed = !existsSync(join(copyDir, slug, "contacts", "rush-one--alpha.md"));
  } catch (err) {
    log(`pull failed: ${err.stderr ?? err}`);
  }
}
rmSync(copyDir, { recursive: true, force: true });
check("…and the refresh command brings the copy up to date", refreshed);

r = await tool(dev, "remove_contact", { path: "contacts/jordan-lee--omega.md", ...E });
check("Dev's preview says Maya logged Jordan too, so only an admin can remove", /only an admin/.test(r.text), r.text);
r = await tool(dev, "remove_contact", { path: "contacts/jordan-lee--omega.md", confirm: "contacts/jordan-lee--omega.md", reason: "test", ...E });
check("…and Dev can't remove Jordan", r.error && /only an admin/.test(r.text), r.text);
r = await tool(maya, "remove_contact", { path: "contacts/jordan-lee--omega.md", confirm: "contacts/jordan-lee--omega.md", reason: "duplicate test entry", ...E });
check("Maya, an admin, can", !r.error && /Removed Jordan Lee/.test(r.text), r.text);
r = await tool(dev, "remove_contact", { path: "contacts/tom-becker--cartco.md", confirm: "contacts/tom-becker--cartco.md", reason: "never met, a target", ...E });
check("Dev removes Tom, whom only he logged", !r.error && /Removed Tom Becker/.test(r.text), r.text);
r = await tool(maya, "targets", E);
check("…so the target Tom shows as not met again", /1 of 3 met/.test(r.text) && /Tom Becker.*not met yet/.test(r.text), r.text);
r = await tool(maya, "contacts_csv", E);
check("The CSV has neither removed contact", !r.text.includes("Rush One") && !r.text.includes("Jordan Lee") && !r.text.includes("Tom Becker") && r.text.includes("Samantha Wu"), r.text);

// ---------------------------------------------------------------- remove Dev
r = await tool(maya, "list_people");
check("list_people shows Maya and Dev", /^2 connector/.test(r.text) && r.text.includes("Dev Patel"), r.text);
r = await tool(maya, "remove_person", { email: "maya@lumenrobotics.test" });
check("Maya can't remove herself (only admin)", r.error, r.text);
r = await tool(maya, "remove_person", { email: "dev@lumenrobotics.test" });
check("remove_person removes Dev", !r.error, r.text);
r = await tool(dev, "whoami");
check("Dev's URL stops working", r.error && /401/.test(r.text), r.text);

r = await tool(maya, "no_such_tool");
check("Unknown tool gives a clean error", r.error, r.text);

// ---------------------------------------------------------------- coverage and cleanup
const missing = toolNames.filter((n) => !used.has(n));
check(`Every tool was called (${used.size}/${toolNames.length})`, missing.length === 0, missing.join(", "));

const team = slidePath && (await tool(maya, "read_file", { path: slidePath, ...E })).text.match(/\/media\/teams\/([a-f0-9]{10})\//)?.[1];
if (team) {
  log(`\nTEAM: ${team}`);
  r = await tool({ name: "Home", key: homeKey }, "delete_team", { team, confirm: team });
  check("Cleanup: delete_team removes the test team", !r.error && r.text.startsWith("Deleted"), r.text);
} else console.log("(Couldn't tell which team to delete: delete it with delete_team as a home admin.)");

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Full log: ${logFile}`);
process.exit(failed.length ? 1 : 0);
