# Platform patterns to verify each run

## Ordinary pagination: Gather Digital / Touchpoint example

A 7x24 directory exposed name, organization, title, stable profile IDs and links in rendered cards. Fifty records per page made DOM traversal simpler than API discovery. Following Next Page captured 27 pages; the last contained 22 records.

The terminal link still had an href to the current page and a disabled class. Inspect enabled state before clicking; do not mistake this for an endless-page failure. Re-inspect selectors, event/list routes and controls each run. Do not hardcode historical event IDs or counts.

The vendor integration API required organization credentials; attendee login did not imply API access. Use the normal participant interface when that is what the account supports.

## Capped search: Grip example

Observed list requests exposed structured records and IDs, but pagination stopped with an invalid-page error while the last page was full. That error was neither a 429 nor a terminal empty page.

When ordinary UI filters offer a legitimate route through the same accessible list:

- Inspect successful filter requests. Preserve list/type/group scope. Public client code may suggest a shape, but verify a real successful response before relying on it. Inspect code/session requests only through capabilities the current tools allow.
- Enumerate filter values using the real cursor protocol. Size batches to observed page caps and URL encoding limits; compare expected/returned counts per batch.
- Values containing delimiters such as `|` can break naive OR concatenation. Use the app's observed representation or collect those values individually.
- Company facets omit blank companies. Recover blanks/NBSP through supported filters or reconcile another independently enumerated facet. Name/title facets may also have blanks or overlaps; establish their scope before treating totals as exhaustive.
- Deduplicate partitions by ID, isolate deficits, and retry only those partitions. Reconcile per-value counts and the final ID union. If coverage remains uncertain, export the accessible partial result and report the gap.
- Promoted cards may repeat separately from normal results; they do not automatically increase the unique-attendee count.

## Profile/contact fields

List and profile schemas may differ. Keep structured title/headline fields; derive titles only from a verified unambiguous rule. Do not blindly split on `at`, since names, titles and companies may contain it.

Contacts may be public, connections-only, private or unpopulated. Collect requested fields visible to the account, preserving visibility/fetch status where relevant. A separate contact endpoint does not make its contents public. Directory collection does not authorize sending connections to reveal details. Do not guess emails or present enrichment as source data.

## Route failures

When another task moves the browser, use another supported read-only route or request an uninterrupted window only when necessary. If screenshot/mirroring remains unavailable, preserve checkpoints and identify the specific needed action/capability. An unavailable or locked UI does not prove a background run succeeded; check saved output.
