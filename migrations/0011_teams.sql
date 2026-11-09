-- Teams on one Worker. The deployment's own team (the "home" team) keeps this
-- database for its CRM data. Every other team keeps its CRM data in its own
-- Durable Object, its events in tm-<id>-* repos and its media under teams/<id>/.
-- This database stays the registry of who is on which team.
--
-- connector_people rows with team_id NULL are on the home team. People from
-- the PEOPLE secret are copied here too (the Worker does it on its next
-- request), so the secret can go. admin = 1 can add and remove teammates.
-- A connector's profile (company, its site, its ideal customer) lives on its
-- row here, so no connector key has to be stored to keep one.

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,          -- short random hex; repos are tm-<id>-*
  name       TEXT NOT NULL DEFAULT '',  -- the company, once the founder gives it
  created_at TEXT NOT NULL
);
CREATE INDEX teams_created ON teams(created_at);

ALTER TABLE connector_people ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE connector_people ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_people ADD COLUMN company TEXT;
ALTER TABLE connector_people ADD COLUMN company_url TEXT;
ALTER TABLE connector_people ADD COLUMN ideal_customer TEXT;
CREATE INDEX connector_people_team ON connector_people(team_id);
