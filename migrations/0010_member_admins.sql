-- Admins among connectors that joined from the landing page. Only whoever runs
-- the deployment sets this, with wrangler (no tool writes it), e.g.:
--   npx wrangler d1 execute agnostic-crm --remote --command
--     "UPDATE members SET admin = 1 WHERE self_serve = 1 AND email = 'you@example.com'"
-- It counts only while the row grants access (self_serve = 1). People in
-- PEOPLE are made admins there; people added from chat never are.
ALTER TABLE members ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
