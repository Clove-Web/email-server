/* lib/db.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { SQL } from "bun";

/*
 * Single shared Postgres connection pool for the whole app.
 *
 * Storage used to be a handful of JSON files on a data volume (emails.json,
 * settings.json, owners.json, subscriptions.json) plus loose attachment files.
 * Everything now lives in Postgres; each lib/* module owns one set of tables.
 *
 * The connection string comes from DATABASE_URL. Bun's SQL client also reads
 * POSTGRES_URL and friends on its own, but we require DATABASE_URL explicitly
 * so a missing config fails loudly at boot instead of silently connecting to
 * the wrong place.
 */

const url =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  process.env.PG_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Point it at your Postgres instance, e.g. " +
      "postgres://user:pass@host:5432/mailbox",
  );
}

export const sql = new SQL(url);

// jsonb columns come back already parsed as JS objects/arrays under Bun, but
// be defensive: tolerate a raw string too, and always fall back to `fallback`.
export function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

// bytea comes back as a Buffer (a Uint8Array subclass) in object mode.
export function asBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return null;
}

let initialized = false;

// Creates every table the app needs, if it isn't there already. Safe to call
// on every boot and safe to run concurrently with a live app.
export async function initDb(): Promise<void> {
  if (initialized) return;

  // Emails: one row per message (inbound, outbound, and drafts alike). Scalar,
  // queried fields are real columns; the recipient list is small and never
  // filtered on, so it rides along as jsonb. `seq` preserves insertion order
  // (newest-first lists used to rely on unshift into the JSON array).
  await sql`
    CREATE TABLE IF NOT EXISTS emails (
      seq          BIGSERIAL   NOT NULL,
      id           TEXT        PRIMARY KEY,
      from_addr    TEXT        NOT NULL DEFAULT '',
      to_addrs     JSONB       NOT NULL DEFAULT '[]',
      subject      TEXT        NOT NULL DEFAULT '',
      html         TEXT,
      body_text    TEXT,
      received_at  TEXT        NOT NULL,
      direction    TEXT        NOT NULL,
      status       TEXT        NOT NULL,
      message_id   TEXT,
      in_reply_to  TEXT,
      refs         TEXT,
      thread_key   TEXT        NOT NULL,
      owner        TEXT        NOT NULL DEFAULT ''
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS emails_thread_key_idx ON emails (thread_key)`;
  await sql`CREATE INDEX IF NOT EXISTS emails_message_id_idx ON emails (message_id)`;
  await sql`CREATE INDEX IF NOT EXISTS emails_owner_idx      ON emails (owner)`;
  await sql`CREATE INDEX IF NOT EXISTS emails_status_idx     ON emails (status)`;
  await sql`CREATE INDEX IF NOT EXISTS emails_seq_idx        ON emails (seq DESC)`;

  // Attachments: metadata + the raw bytes (bytea). email_id is nullable so an
  // attachment can be uploaded/persisted before its email row exists, then
  // linked once the email is saved. Deleting an email cascades to its files.
  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      seq          BIGSERIAL   NOT NULL,
      id           UUID        PRIMARY KEY,
      email_id     TEXT        REFERENCES emails(id) ON DELETE CASCADE,
      filename     TEXT        NOT NULL DEFAULT 'attachment',
      content_type TEXT        NOT NULL DEFAULT 'application/octet-stream',
      size         INTEGER     NOT NULL DEFAULT 0,
      content_id   TEXT,
      bytes        BYTEA
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS attachments_email_id_idx ON attachments (email_id)`;

  // Settings: a single-row table (id is pinned to 1).
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      from_addresses JSONB   NOT NULL DEFAULT '[]',
      default_from   TEXT
    )
  `;

  // Ownership config: also a single row (id pinned to 1). Mirrors owners.json.
  await sql`
    CREATE TABLE IF NOT EXISTS owners_config (
      id        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      domain    TEXT    NOT NULL DEFAULT '',
      admins    JSONB   NOT NULL DEFAULT '[]',
      catch_all TEXT    NOT NULL DEFAULT '',
      owners    JSONB   NOT NULL DEFAULT '{}'
    )
  `;

  // Web-push subscriptions, keyed by their unique endpoint.
  await sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      sub      JSONB NOT NULL
    )
  `;

  initialized = true;
}
