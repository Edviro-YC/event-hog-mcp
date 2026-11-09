-- Teammates added from chat with add_person. The Worker can't change its own
-- PEOPLE secret, so people added at runtime live here, next to it. Connector
-- keys are never stored: key_hash is the SHA-256 of the key, capture_hash the
-- SHA-256 of the person's camera-page token. query_crm can't read this table.
CREATE TABLE connector_people (
  key_hash     TEXT PRIMARY KEY,
  capture_hash TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,           -- lowercased; commits are authored as this
  emails       TEXT,                    -- JSON array of other addresses
  crm_email    TEXT,
  added_by     TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  removed_by   TEXT,
  removed_at   TEXT
);
CREATE INDEX connector_people_email ON connector_people(email);
