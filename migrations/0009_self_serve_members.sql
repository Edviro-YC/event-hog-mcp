-- A members row grants access on its own only if it joined from the landing
-- page (self_serve = 1). save_my_profile also writes a row here for people in
-- PEOPLE or connector_people; those stay 0, so removing someone from PEOPLE or
-- with remove_person locks them out even after they saved a profile.
--
-- Rows already here with a landing-page key (48 lowercase hex characters)
-- joined that way. Any other key came from PEOPLE.
ALTER TABLE members ADD COLUMN self_serve INTEGER NOT NULL DEFAULT 0;
UPDATE members SET self_serve = 1 WHERE length(key) = 48 AND key NOT GLOB '*[^0-9a-f]*';
