/* scripts/migrate-json-to-pg.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
/*
 * One-time migration: JSON files on the data volume  ->  Postgres.
 *
 * Imports the old file-based storage into the new tables:
 *   data/emails.json         -> emails (+ attachments, bytes read from disk)
 *   data/settings.json       -> settings
 *   data/owners.json         -> owners_config
 *   data/subscriptions.json  -> push_subscriptions
 *   data/attachments/<id>    -> attachments.bytes (bytea)
 *
 * Safe to re-run: existing email rows are left untouched (so app data written
 * after a first migration is preserved), while settings/owners are re-imported
 * from the files. Run it once, before pointing production at Postgres:
 *
 *   DATABASE_URL=postgres://…  DATA_DIR=./data  bun run scripts/migrate-json-to-pg.ts
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { sql, initDb } from "../lib/db";
import { initOwners, ownerOf } from "../lib/owners";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

function readJson<T>(name: string, fallback: T): T {
  const file = path.join(DATA_DIR, name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    console.error(`Could not parse ${name}:`, err);
    return fallback;
  }
}

// --- owners.json -> owners_config -----------------------------------------
async function migrateOwners() {
  // Prefer the writable copy on the data volume; fall back to the repo seed.
  const raw =
    (existsSync(path.join(DATA_DIR, "owners.json"))
      ? readJson<any>("owners.json", null)
      : null) ??
    (existsSync(path.join(import.meta.dir, "..", "owners.json"))
      ? JSON.parse(readFileSync(path.join(import.meta.dir, "..", "owners.json"), "utf8"))
      : null);

  if (!raw) {
    console.log("owners: no owners.json found, skipping");
    return;
  }

  const domain = String(raw.domain ?? "").toLowerCase();
  const admins = Array.isArray(raw.admins) ? raw.admins.map((a: string) => a.toLowerCase()) : [];
  const catchAll = String(raw.catchAll ?? "").toLowerCase();
  const owners: Record<string, string[]> = {};
  for (const [user, entries] of Object.entries(raw.owners ?? {})) {
    owners[String(user).toLowerCase()] = Array.from(
      new Set((entries as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    );
  }

  await sql`
    INSERT INTO owners_config (id, domain, admins, catch_all, owners)
    VALUES (1, ${domain}, ${JSON.stringify(admins)}::jsonb, ${catchAll}, ${JSON.stringify(owners)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      domain = EXCLUDED.domain, admins = EXCLUDED.admins,
      catch_all = EXCLUDED.catch_all, owners = EXCLUDED.owners
  `;
  console.log(`owners: imported domain "${domain}", ${Object.keys(owners).length} reservation set(s)`);
}

// --- settings.json -> settings --------------------------------------------
async function migrateSettings() {
  const raw = readJson<any>("settings.json", null);
  if (!raw) {
    console.log("settings: no settings.json found, skipping");
    return;
  }
  const fromAddresses = Array.isArray(raw.fromAddresses)
    ? raw.fromAddresses.filter((x: unknown) => typeof x === "string")
    : [];
  const defaultFrom = typeof raw.defaultFrom === "string" ? raw.defaultFrom : null;

  await sql`
    INSERT INTO settings (id, from_addresses, default_from)
    VALUES (1, ${JSON.stringify(fromAddresses)}::jsonb, ${defaultFrom})
    ON CONFLICT (id) DO UPDATE SET
      from_addresses = EXCLUDED.from_addresses, default_from = EXCLUDED.default_from
  `;
  console.log(`settings: imported ${fromAddresses.length} from-address(es)`);
}

// --- subscriptions.json -> push_subscriptions -----------------------------
async function migrateSubscriptions() {
  const subs = readJson<any[]>("subscriptions.json", []);
  let n = 0;
  for (const sub of subs) {
    if (!sub || typeof sub.endpoint !== "string") continue;
    await sql`
      INSERT INTO push_subscriptions (endpoint, sub)
      VALUES (${sub.endpoint}, ${JSON.stringify(sub)}::jsonb)
      ON CONFLICT (endpoint) DO UPDATE SET sub = EXCLUDED.sub
    `;
    n++;
  }
  console.log(`subscriptions: imported ${n} device(s)`);
}

// --- emails.json (+ attachment files) -> emails / attachments -------------
async function migrateEmails() {
  const emails = readJson<any[]>("emails.json", []);
  let inserted = 0;
  let skipped = 0;
  let files = 0;

  for (const e of emails) {
    if (!e || typeof e.id !== "string") continue;

    const direction = e.direction === "outbound" ? "outbound" : "inbound";
    const status = e.status === "draft" ? "draft" : "sent";
    const to: string[] = Array.isArray(e.to) ? e.to : [];
    const from: string = typeof e.from === "string" ? e.from : "";
    // Backfill owner exactly as the old store's normalize() did.
    const owner =
      typeof e.owner === "string" && e.owner
        ? e.owner
        : direction === "inbound"
          ? ownerOf(to[0] ?? "")
          : ownerOf(from);

    const rows = (await sql`
      INSERT INTO emails (
        id, from_addr, to_addrs, subject, html, body_text, received_at,
        direction, status, message_id, in_reply_to, refs, thread_key, owner
      ) VALUES (
        ${e.id}, ${from}, ${JSON.stringify(to)}::jsonb, ${String(e.subject ?? "")},
        ${e.html ?? null}, ${e.text ?? null}, ${String(e.receivedAt ?? new Date().toISOString())},
        ${direction}, ${status}, ${e.messageId ?? null}, ${e.inReplyTo ?? null},
        ${e.references ?? null}, ${String(e.threadKey ?? `legacy::${e.id}`)}, ${owner}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as Array<{ id: string }>;

    // Already migrated (or a live row with this id) — don't touch its attachments.
    if (rows.length === 0) {
      skipped++;
      continue;
    }
    inserted++;

    const attachments: any[] = Array.isArray(e.attachments) ? e.attachments : [];
    for (const a of attachments) {
      const attId = typeof a?.id === "string" && a.id ? a.id : crypto.randomUUID();
      const filename = typeof a?.filename === "string" ? a.filename : "attachment";
      const contentType = typeof a?.contentType === "string" ? a.contentType : "application/octet-stream";
      const contentId = typeof a?.contentId === "string" ? a.contentId : null;

      // Pull the bytes off disk if this attachment had a stored file.
      let bytes: Buffer | null = null;
      if (typeof a?.id === "string" && a.id) {
        const p = path.join(ATTACHMENTS_DIR, a.id);
        if (existsSync(p)) {
          bytes = readFileSync(p);
          files++;
        }
      }
      const size = bytes ? bytes.length : Number(a?.size ?? 0);

      await sql`
        INSERT INTO attachments (id, email_id, filename, content_type, size, content_id, bytes)
        VALUES (${attId}, ${e.id}, ${filename}, ${contentType}, ${size}, ${contentId}, ${bytes})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  console.log(
    `emails: inserted ${inserted}, skipped ${skipped} (already present), ${files} attachment file(s) imported`,
  );
}

async function main() {
  console.log(`Migrating JSON storage from ${DATA_DIR} into Postgres…`);
  await initDb();
  await migrateOwners();
  await initOwners(); // hydrate the cache so ownerOf() works for the email backfill
  await migrateSettings();
  await migrateSubscriptions();
  await migrateEmails();
  console.log("Done.");
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
