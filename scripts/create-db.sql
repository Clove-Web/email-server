/* scripts/create-db.sql
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
-- Create a dedicated Postgres role + database for the mailbox app.
--
-- You only need this if you are pointing DATABASE_URL at a Postgres server you
-- already run. The database in the bundled compose.yml creates its own role and
-- database from POSTGRES_PASSWORD, so skip this file entirely if you use that.
--
-- Run ONCE as a superuser, e.g.:
--   psql -U postgres -f scripts/create-db.sql
--   docker exec -i <your-postgres-container> psql -U postgres < scripts/create-db.sql
--
-- Change the password below, then put it (URL-encoded if it has special
-- characters) into DATABASE_URL in your .env. The tables themselves are created
-- automatically on boot by initDb().

CREATE ROLE mailbox WITH LOGIN PASSWORD 'change-me-strong';
CREATE DATABASE mailbox OWNER mailbox;
