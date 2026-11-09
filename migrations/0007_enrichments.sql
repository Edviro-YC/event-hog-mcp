-- People lookups (enrich_people), cached so a teammate asking about the same
-- person later doesn't spend credits again. Misses are cached too.
--
-- Keyed by lowercased "name|company" as given, not by persons.id: lookups
-- run on roster entries before anyone is a target or a contact.

CREATE TABLE enrichments (
  lookup_key     TEXT PRIMARY KEY,      -- lower(trim(name)) || '|' || lower(trim(company))
  name           TEXT NOT NULL,
  company        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('candidate', 'not_found')),
  score          INTEGER,               -- identity match, 0-100
  title          TEXT,                  -- current role
  organization   TEXT,
  org_domain     TEXT,
  linkedin       TEXT,
  email          TEXT,
  location       TEXT,
  checked_at     TEXT,                  -- when the provider last refreshed the profile
  last_updated   TEXT,                  -- when the profile itself last changed
  credits        INTEGER NOT NULL DEFAULT 0,
  raw            TEXT,                  -- the provider's JSON, for re-reading later
  enriched_at    TEXT NOT NULL,
  enriched_by    TEXT NOT NULL
);
