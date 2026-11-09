---
name: draft-follow-up-emails
description: Draft post-conference follow-up emails, one per person met, from what was actually said and logged in EventHog. Use after an event when someone asks to "draft follow-ups", "write the emails to everyone I met", "follow up with the A list", or "make templates for our follow-ups". Picks a template by priority and situation (promised something, asked for a meeting, warm intro, light touch), fills it only from touchpoint notes and confirmed research, leaves [gaps] for anything unknown, and saves each as an email draft with save_draft. Nothing is sent; for sending at scale it points to Origami.
---

# Draft Follow-Up Emails

The best follow-up is short, arrives within two days, and proves you were
listening. Every sentence that could have been sent to anyone else makes it
weaker. This skill writes them from the team's own notes.

## 1. Gather who to write to

- `get_started` (after phase) lists who to follow up with, most important
  first. Or run `query_crm` for this event's interactions with follow-ups,
  and `targets` with `status: "met"`.
- For each person, `read_file` their contact file (`contacts/...md`): every
  touchpoint, who met them, what was said, the follow-up that was promised.
- Ask the person which to draft: all A's, everyone with a follow-up, or a
  list they name. Start with five, show them, then do the rest.

## 2. Pick the template

| Situation | Template |
|---|---|
| We promised something (a deck, a case study, pricing, an intro) | **Deliver** |
| They asked for a call or a demo | **Book it** |
| A good conversation, no clear next step | **Pick up the thread** |
| Someone introduced us, or we met through a teammate | **Warm intro** |
| Brief hello, priority C | **Light touch** |

**Deliver**
> Subject: The [thing] I mentioned at [event]
>
> Hi [first name], good talking with you at [where we met] about
> [their problem, in their words]. Here's the [thing] I promised: [link or
> attachment]. [One line on the part most relevant to them.]
>
> [One question that moves it forward, e.g. "Worth 20 minutes next week to
> walk through it with your team?"]

**Book it**
> Subject: Picking up from [event]
>
> Hi [first name], you mentioned [their need]. Here are two times that work
> for a [length] call: [time 1], [time 2]. Or grab one here: [booking link].
> I'll come ready with [what we'll show them].

**Pick up the thread**
> Subject: [Specific topic from the conversation]
>
> Hi [first name], I keep thinking about what you said about [detail]. [One
> sentence connecting it to what the company does, or a useful resource with
> no ask.] Would it be useful to [small next step]?

**Warm intro**
> Subject: [Introducer] suggested we talk
>
> Hi [first name], [introducer] and I met at [event] and thought we should
> connect because [reason]. [One line on what we do, framed around them.]
> Open to a short call?

**Light touch**
> Subject: Good to meet you at [event]
>
> Hi [first name], good to meet you at [where]. If [their area] is ever on
> your list, I'd be glad to share what we're seeing at [similar orgs]. Either
> way, enjoy the rest of the season.

## 3. Fill it, without inventing

- Use only what's in the contact file, the targets reason, or a source you
  retrieved. A detail you can't source becomes a `[gap]`.
- Their words beat yours: quote or paraphrase what they said they care about.
- Never invent a promise, a number, a mutual connection or a meeting time.
- Sender: the teammate who met them (`first_logged_by` in the contact file),
  in their own voice (`get_config` with `skill:
  "parallel-content-generation-starters"` has personal voices). If someone
  else is sending, say so in the first line.
- Keep it under 120 words. One ask, at the end.
- Respect discretion: don't mention a hallway conversation's details to
  anyone but the person in it.

## 4. Save

One draft per person: `save_draft` with `kind: "email"`, `title: "Follow-up:
[Name], [Company]"`, `status: "draft"` (or `"outline"` while gaps remain),
the email as `body` with the subject on the first line, and `from` set to
their contact file. Show the person each draft (or a table of them) and fill
the gaps they answer with `add_to_draft` (`mode: "version"`).

## 5. Sending

EventHog never sends. The person sends from their own email, or:

- **Their CRM:** once contacts are synced (the `crm-sync` prompt), the
  drafts can go out as CRM emails or sequences, with owner set to the sender.
- **Origami** (https://origami.chat), for more than a handful: it enriches
  leads (emails, company data) and runs email campaigns, with approval before
  anything goes out. If its MCP server (`https://mcp.origami.chat`, with an
  Origami API key) is connected, offer to load the approved drafts into a
  campaign. Otherwise tell the person it's there.

Mark nothing as sent unless the person says it was.
