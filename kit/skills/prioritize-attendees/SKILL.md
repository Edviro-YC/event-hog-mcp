---
name: prioritize-attendees
description: Turn a conference attendee roster into a short, sourced list of who is worth finding, for the company the person represents. Use after conference-attendee-export (or any attendee, speaker, sponsor or exhibitor list) when someone asks "who should I meet?", "who's worth finding?", "rank this list", or "prep me for the conference". Screens the roster against the company's ideal customer, enriches only the plausible fits (enrich_people first, web research for the rest), classifies each as buyer, champion, partner or referral, scores A, B or C with a reason and sources, saves them with save_targets, and presents the top 10 to 15. Never pads the list and never treats a roster entry as someone already met.
---

# Prioritize Attendees

A roster of 800 names is useless on the floor. A list of twelve people, each
with one line on why they matter and how to spot them, is how a team spends
three days well. This skill gets from the first to the second without
inventing anything.

## 0. Know what you're ranking for

- **The company and its ideal customer.** `get_started` and `whoami` show
  the company the person represents. If there's no ideal customer saved,
  read the company's website and propose one line ("facilities and energy
  directors at K-12 districts and data centers; the VP of operations signs
  off"). Confirm it with the person, then `save_my_profile` with
  `ideal_customer` and `company_url`.
- **What a good conversation looks like for them.** Ask once if it isn't
  obvious: are they there to sell, to find partners, to hire, or to learn?
  It changes who counts as an A.
- **Research tools.** `get_config` with `skill: "prioritize-attendees"`, else
  `augment-speakers-panelists`, for this person's research tools in order.
  Fall back to the chat's built-in web search. Never refuse to start because
  a preferred tool is missing.

## 1. Get the roster

- `read_file` with `prep/attendees.csv` (saved by `conference-attendee-export`
  through `save_attendees`). Also check `prep/` for a speaker or sponsor
  list and `speakers/` for researched profiles.
- No roster? Run `conference-attendee-export` first, or use what the event
  publishes: speakers, sponsors, exhibitors.

## 2. Screen before you research

Researching every name wastes the person's time and your context. Screen the
whole roster on what it already says, title and company, into three piles
(no lookups or searches yet):

- **Plausible fit:** the company is the kind that buys, partners or refers,
  and the title can decide, influence or introduce.
- **Maybe:** the right company with an unclear title, or a clear title at an
  unknown company.
- **No:** students, press, vendors selling the same thing (unless partners
  are the goal), and anyone with nothing to go on.

Research the plausible fits first, then the maybes if there's room. Tell the
person how many fell in each pile.

## 3. Enrich, with sources

**Look people up first.** Send the plausible fits to `enrich_people`, 25 per
call (name and company as on the roster), then the maybes if there's room.
It's faster than searching one by one, and teammates' lookups come back from
the cache for free. Each person comes back as:

- **confirmed:** current title, employer, LinkedIn, sometimes a work email.
  Treat identity and role as settled. If it says the employer differs from
  the roster, they've moved: re-screen them.
- **UNCONFIRMED:** a possible match. Check it with web search before using
  anything from it.
- **not found:** research them with web search as below, or leave them out.

If `enrich_people` says the lookup is unavailable or out of credits, carry on
with web search for everyone. Never stop because of it.

**Then web search, only for what the lookup doesn't give**, in this order, and
stop when you know enough:

1. **The company:** what it does, its size, whether it plausibly has the
   problem the person's company solves. One or two sources.
2. **The person**, if not confirmed above: confirm they're at that company in
   that role now (LinkedIn, the company's team page, recent coverage). If
   identity is uncertain, say so and keep it out of the A list.
3. **A reason to talk:** a project, a quote, a session they're speaking at, a
   recent hire or expansion. This becomes the opener.

Only report links you actually retrieved. Never fill a gap with a guess.
Emails from the lookup are unverified: never present one as verified, and
never guess one from a company's email pattern.

## 4. Classify and score

- **Role** (what they'd be to the company): `buyer` (signs or holds the
  budget), `champion` (feels the pain, pushes it internally), `partner`
  (sells alongside, integrates, resells), `referral` (knows the buyers).
  Don't promote a champion to buyer, or a vendor to a customer, to make the
  list look better.
- **Priority:**
  - **A, must find:** strong fit, the right role, and a concrete reason to
    talk now. Usually 5 to 15 people. Fewer is fine.
  - **B, good to meet:** fit is likely but something's missing.
  - **C, if you cross paths:** worth a hello, not worth hunting.
- **Why:** one line, specific to this company and person. "VP Facilities at
  a 40-school district that just passed a bond for HVAC upgrades" beats
  "decision maker in target market".
- **How to spot them:** their session, panel or booth, or their company's
  booth number, when the roster or agenda says.

## 5. Save

`save_targets` (pass `event`), up to 25 per call; call again for more. Save
A and B. Save C only if the person wants them. Include `title`, `company`,
`linkedin` and `email` when confirmed, `role`, `priority`, `why`,
`how_to_spot` and `sources` (the LinkedIn URL counts as the source for a
confirmed lookup).

Targets are not contacts. Nobody is "met" until someone logs them with
`log_contact`, which then attaches to the same person, so `targets` can show
who's been found.

## 6. Present

A short, phone-friendly list, A first:

> **[A] Jane Doe, VP Facilities, Acme School District** (buyer). Just passed
> a $40M bond with HVAC in scope. Speaking Tue 2pm, "Funding Efficiency".

Then: how many were screened, researched and saved, what you couldn't
confirm, and the one line on how the event itself works: "When you meet
someone, just tell me. A sentence or a badge photo is enough."

## Rules

- The full roster and the shortlist stay separate. The roster is reference;
  targets are judgments with reasons.
- No padding. If only six people are A, there are six.
- Identity before research. A common name at a big company gets confirmed
  before anything is attributed to it.
- Nothing is sent and nobody is contacted from this skill. Outreach is a
  separate step with its own approval.
