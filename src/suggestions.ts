// Keeping the conversation moving: what_can_i_do lists what a person can say
// to event-hog right now, for the phase they're in, and NEXT_STEPS gives the
// agent a few follow-on offers after each tool, so every reply can end with
// "you could also...". Phrased as things the person would say, not tool names.

import type { Env, Handler } from "./index";
import { guessPhase, todayIn, type Phase } from "./onboarding";

type Offer = { say: string; tools: string };

const MENU: Record<Phase, Offer[]> = {
  before: [
    { say: "Who should I find at this event?", tools: "conference-attendee-export, prioritize-attendees, enrich_people, save_targets" },
    { say: "Who is <speaker>? (or a screenshot of their bio)", tools: "augment-speakers-panelists, save_speaker_profile" },
    { say: "Quiz me on the acronyms I'll hear there", tools: "save_flash_cards, flash_cards" },
    { say: "Draft a post saying we'll be there", tools: "save_draft" },
    { say: "What's the plan, and who's going from our team?", tools: "event_brief" },
  ],
  during: [
    { say: "Met Jane Doe, VP Ops at Acme. Wants the case study. (or a badge or card photo)", tools: "log_contact" },
    { say: "Who should I find next?", tools: "targets" },
    { say: "Who have we met from Acme?", tools: "search, query_crm" },
    { say: "Write up my slides", tools: "slide_capture_link, save_slide_notes" },
    { say: "Note: the keynote said...", tools: "add_note" },
    { say: "Daily brief", tools: "event_brief, recent_activity" },
  ],
  after: [
    { say: "Who should I follow up with first?", tools: "get_started (after), query_crm" },
    { say: "Draft follow-up emails for my A-list", tools: "draft-follow-up-emails, save_draft" },
    { say: "Put my contacts and meetings in HubSpot", tools: "crm_queue, mark_crm_synced, mark_touchpoints_synced" },
    { say: "Give me a CRM import file instead", tools: "export_hubspot_csv" },
    { say: "Recreate that slide in our brand", tools: "recreate-slides-in-brand, save_recreated_slide" },
    { say: "Turn my notes into a LinkedIn post", tools: "save_draft" },
  ],
};

const offers = (list: Offer[]) => list.map((o) => `- "${o.say}" (${o.tools})`).join("\n");

export const SUGGESTION_TOOLS = [
  {
    name: "what_can_i_do",
    description:
      "What the person can ask event-hog to do right now, for where they are with the event (before, during or after), as things they'd say. Use when they ask what event-hog can do, seem unsure, or finish a task and need a next step.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string", description: "before, during or after. Leave out to work it out from the event's dates." },
        event: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

export const SUGGESTION_HANDLERS: Record<string, Handler> = {
  async what_can_i_do(args, env: Env) {
    const slug = args?.event ? String(args.event) : env.DEFAULT_EVENT;
    const i = await env.CRM.prepare("SELECT name, starts_on, ends_on, time_zone FROM event_instances WHERE slug = ?").bind(slug).first();
    const asked = ["before", "during", "after"].includes(String(args?.phase)) ? (args.phase as Phase) : null;
    const phase = asked ?? (i ? guessPhase(i as any, todayIn(i.time_zone as string | null, env.EVENT_TIMEZONE)) : null) ?? "before";
    const others = (["before", "during", "after"] as Phase[]).filter((p) => p !== phase);
    return [
      `${i ? `${i.name}: ` : ""}${phase} the event. Show the person the "now" list as a short menu in their words (no tool names), and ask which they want.`,
      "",
      `Now (${phase}):`,
      offers(MENU[phase]),
      "",
      `Later (${others.join(", ")}), mention in one line at most:`,
      ...others.map((p) => `- ${p}: ${MENU[p].slice(0, 3).map((o) => `"${o.say}"`).join(" · ")}`),
      "",
      'Any time: "What can event-hog do?" brings this back.',
    ].join("\n");
  },
};

// After a tool runs: a few offers for the agent's closing line.
const next = (...say: string[]) =>
  `Next: end your reply with one short line offering 2 or 3 of these, in the person's words (skip any they just did): ${say.map((s) => `"${s}"`).join(" · ")}`;

export const NEXT_STEPS: Record<string, string> = {
  new_event: next("Pull the attendee list", "Who's speaking that I should know?", "Who should I find there?"),
  save_attendees: next("Rank them: who should I find?", "Look up the top names", "Who's speaking?"),
  enrich_people: next("Save the good fits as targets", "Search the web for the ones not found", "Show me my top 10"),
  save_targets: next("Show me my top 10", "Who's speaking that I should know?", "Quiz me on this show's acronyms"),
  targets: next("Met one of them? Just tell me", "Look up the rest", "Who has the team met so far?"),
  save_speaker_profile: next("Give me 3 questions to ask them", "Quiz me on their topic", "Draft a post about their session"),
  log_contact: next("Who should I find next?", "Who else have we met from their company?", "Draft my follow-up to them"),
  add_note: next("Quiz me on the terms from that", "Turn that into a LinkedIn post", "Write up my slides from it"),
  save_slide_notes: next("Recreate the best slide in our brand", "Turn this talk into a post", "Quiz me on its terms"),
  event_brief: next("Who should I find next?", "Who did the team meet today?", "Daily brief"),
  recent_activity: next("Who haven't we met yet?", "Put today's contacts in the CRM", "Draft follow-ups for today"),
  save_flash_cards: next("Quiz me now", "Add cards for another session"),
  save_draft: next("Draft the next one", "Show me all my drafts", "Make it shorter"),
  crm_queue: next("Go ahead and create them", "Only mine, owned by me", "Give me an import file instead"),
  mark_crm_synced: next("Log the conversations as meetings too", "Draft the follow-up emails", "Who's still pending?"),
  mark_touchpoints_synced: next("Draft the follow-up emails", "Who's still pending?"),
  export_hubspot_csv: next("Draft the follow-up emails", "Connect HubSpot so you can push them directly"),
  query_crm: next("Log someone new", "Who should I follow up with?", "Who should I find next?"),
  search: next("Log someone new", "Who should I find next?"),
};
