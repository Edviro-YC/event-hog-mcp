-- Self-serve connectors. Anyone who copies the landing page's prompt gets a
-- random key; the first call with that key creates their row here. The
-- PEOPLE secret still works and wins over this table for the same key.
--
-- The key is the credential (it's in the connector URL), stored as the
-- PEOPLE secret stores it. capture_token is derived from it, so the slide
-- capture page and upload links can find the person without the key.

CREATE TABLE members (
  key            TEXT PRIMARY KEY,
  capture_token  TEXT NOT NULL UNIQUE,
  name           TEXT,
  email          TEXT,
  company        TEXT,
  company_url    TEXT,
  ideal_customer TEXT,                -- one line: who buys what the company sells
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
