# Audit helper input

The helper audits a normalized JSON checkpoint; it does not fetch pages or write CSVs. Preserve original responses separately when adapting them to this shape.

```json
{
  "event": "Example Conference",
  "source_url": "https://events.example/directory",
  "started_at": "2026-01-01T12:00:00Z",
  "completed_at": "2026-01-01T12:05:00Z",
  "ended": true,
  "end_evidence": {"next_disabled": true},
  "pages": [
    {
      "page": 1,
      "url": "https://events.example/directory?page=1",
      "captured_at": "2026-01-01T12:00:01Z",
      "rows": [
        {"id": "123", "name": "Ada Example", "title": "Facilities Manager", "company": "Example Co", "profile_url": "https://events.example/people/123"}
      ]
    }
  ]
}
```

One checkpoint covers one event/list scope. Use a `partition` string per page when filters have separate pagination. Supply observed integer `page` indexes when applicable; omit for opaque cursor/scroll units. An `error` on a checkpoint or unit denotes an unresolved error.

Each row needs stable `id` or `profile_url`; name/title/company are text or null. The helper trims Unicode whitespace for comparisons, leaves input untouched, reports conflicting source fields for one identity, and preserves distinct IDs sharing displayed fields.

Record terminal evidence actually observed, using one of:

- `next_disabled: true`
- `api_has_more: false`
- `empty_page_verified: true`
- `partition_reconciliation_verified: true` after reconciling accessible scope, blanks and partitions

`ended: true` alone is insufficient. Do not invent evidence to pass the helper. Scope, field mapping, filter completeness and the truth of terminal observations remain the collecting agent's responsibility.

```bash
python3 scripts/audit_capture.py capture.json --expected-count 1322 --output coverage.json
python3 scripts/audit_capture.py --self-test
```

Supply optional `--expected-count` only for a source-established total of this scope, not a desired lead count. Exit 0 means recorded checks pass; exit 2 means review is needed. Review findings can accompany a clearly labeled partial export. The helper never changes the input or resolves source conflicts.
