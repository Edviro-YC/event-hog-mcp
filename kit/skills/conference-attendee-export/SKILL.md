---
name: conference-attendee-export
description: Extract a conference attendee directory accessible to the user into verified attendee and company CSVs, using a built-in export, observed requests, or browser pagination. Use for attendee scraping, resumable collection, and coverage checks; not general conference discovery or outreach execution.
---

# Conference Attendee Export

Produce a reusable roster with evidence of what was collected and what remains inaccessible. Treat event, platform, account, requested fields, output location, and prospect criteria as run-specific inputs.

## Scope and discovery

- Distinguish a request for a plan from permission to collect. Default collection fields to name, title, and company unless the user requests others. Lead ranking, email enrichment, CRM imports, connections, meetings, and outreach are separate tasks.
- Inspect the actual event directory. Record event identity, list scope, search/filter state, sort order, sample fields, pagination controls, and any independently displayed total. An accessibility-tree item count is not an attendee total.
- Let the user establish any required login. Reuse a suitable signed-in browser, including Safari when supported; switching browsers is not inherently necessary. Check for an official browser version before using mobile mirroring.
- Prefer a complete built-in attendee export. A connections/meetings export is not equivalent. Otherwise choose observed read-only directory requests or rendered-page traversal based on available capabilities and effort.
- Browser/computer-use tool restrictions govern execution. Do not work around them with hidden app state, browser-session file access, arbitrary console execution, or shell HTTP calls. Request replay is an option only when current tools permit it and the request/session can be obtained legitimately.

## Collect and checkpoint

1. Validate a small sample before scaling. List cards may truncate values; inspect profile details only when needed. Prefer structured title/company fields. Preserve original fields when deriving a fuller title from a headline.
2. Traverse the requested list and account's accessible scope. Follow observed next links/cursors or the exact successful request shape. Do not invent endpoints, assume larger page sizes, enumerate unknown IDs, or substitute organizer credentials for attendee access.
3. Run sequentially with a modest configurable stagger. A 3–6-second delay worked for one paginated directory; it is a starting point, not a universal rate limit. Honor Retry-After, back off on 429/transient failures, and bound retries. Stop dependent collection on expired authorization or persistent pagination/schema errors; preserve progress and report what is needed.
4. Save each successful page/partition with its locator, capture time, source IDs/profile URLs, and raw fields. Resume missing or failed units without restarting completed work. Keep auth headers, cookies, login codes, and passwords out of checkpoints, scripts, logs, and deliverables.
5. Inspect the actual end state before following a next control. A disabled link may retain an href to the current page. A short page, unchanged scroll view, HTTP error, or repeated result set alone does not prove completion.

For page caps, filters, or platform-specific quirks, read the relevant section of [references/platform-patterns.md](references/platform-patterns.md). These are examples to re-inspect, not permanent endpoint contracts.

## Coverage and identity

- Deduplicate by stable attendee ID within this event/list, falling back to stable profile URL. If neither exists, preserve records and report that reliable identity deduplication is unavailable. Never collapse distinct IDs merely because name/title/company match.
- Detect repeated pages/cursors, numeric-page gaps where applicable, conflicting values for one identity, failed units, and mismatches against legitimate totals. Reconcile partitions individually and as a unique-ID union. Do not sum overlapping facet counts as a directory total.
- Record Unicode-aware blanks, missing-field counts, capture date, scope, terminal evidence, and unresolved errors. A missing title/company/email differs from a missed attendee.
- Claim all accessible directory pages only when traversal or partition reconciliation supports it. Do not claim all registrants when hidden profiles, scoped lists, filters, or unavailable totals limit that conclusion. Describe partial coverage precisely.
- Optional mechanical check: normalize a checkpoint using [references/capture-contract.md](references/capture-contract.md), then run `python3 scripts/audit_capture.py capture.json --output coverage.json`. This helper checks recorded evidence/counts; it cannot independently prove source traversal. Inspect its findings before delivery.

## Deliver

Use the available spreadsheet workflow for CSV authoring/validation. Preserve raw captures separately; do not overwrite them with cleaning, enrichment, company normalization, or lead judgments.

- **Attendees:** requested fields, commonly `name,title,company`. Keep source IDs/profile URLs internally or in a requested provenance-rich export.
- **Companies:** if requested, distinct nonblank labels and attendee counts. Trim outer whitespace; preserve spelling/case variants unless normalization is requested. Company counts plus blank-company attendees must reconcile to unique attendees.
- **Coverage:** compact JSON or prose with event/source, capture time, scope, page/partition counts, unique identities, blanks, duplicates/conflicts, terminal evidence, and gaps.

Verify headers, RFC4180 quoting, Unicode, multiline fields, spreadsheet-formula handling, row counts, and source reconciliation. Verify files exist before linking them. Label capture freshness; an older export is not a live list.

If ranking is requested, read the user's current product/ICP source, retain source records, and distinguish buyer/champion/partner/referral. Do not turn contacts at operator companies into verified operators, screened candidates into qualified buyers, or a requested batch size into permission to pad relevance. Keep shortlists distinct from the full roster; enrichment and outreach retain their own authorization boundaries.

## With EventHog

When EventHog is connected (this skill was loaded with `get_skill`):

- Read the references with `get_skill` and `file: "references/platform-patterns.md"` or `"references/capture-contract.md"`. The audit helper is `file: "scripts/audit_capture.py"`; save it locally and run it only if you have a shell. Without one, do the coverage checks by hand and say so.
- The person signs in to the event platform themselves, in their own browser. Never ask for their password or login code.
- Deliver into the event's workspace with `save_attendees` (pass `event`): the attendee CSV, the companies CSV if collected, the coverage summary, and the source. That roster is reference only; nobody becomes a contact from it.
- Then hand off to `prioritize-attendees` for ranking. Ranking, enrichment and outreach stay separate steps, as above.
