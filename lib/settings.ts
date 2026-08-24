/* lib/settings.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { sql, asJson } from "./db";

// User-managed configuration. Right now that's just the list of addresses the
// account is allowed to send as, plus which one is the default. It used to live
// in settings.json next to the mail; it's now a single row in Postgres.
export type Settings = {
  // "Name <addr@domain>" or bare "addr@domain"
  fromAddresses: string[];
  defaultFrom: string | null;
};

// Pulls a bare, lowercased address out of "Name <addr@domain>" or "addr@domain".
export function bareAddress(input: string | undefined | null): string {
  if (!input) return "";
  const match = input.match(/<([^>]+)>/);
  return (match?.[1] ? match[1] : input).trim().toLowerCase();
}

// Light structural check only — real deliverability is enforced by Resend at
// send time, which rejects unverified domains.
export function isValidAddress(input: string): boolean {
  const bare = bareAddress(input);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare);
}

export function parseAddressList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of list) {
    const key = bareAddress(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// First-run defaults come from the SEND_FROM env var so existing single-address
// setups carry over without any manual migration.
function seedFromEnv(): Settings {
  const seeded = dedupe(parseAddressList(process.env.SEND_FROM));
  return {
    fromAddresses: seeded,
    defaultFrom: seeded[0] ?? null,
  };
}

function normalize(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fromAddresses = Array.isArray(r.fromAddresses)
    ? dedupe(r.fromAddresses.filter((x): x is string => typeof x === "string"))
    : [];

  let defaultFrom = typeof r.defaultFrom === "string" ? r.defaultFrom : null;
  const df = defaultFrom;
  // Keep defaultFrom pointing at an address that still exists.
  if (df && !fromAddresses.some((a) => bareAddress(a) === bareAddress(df))) {
    defaultFrom = null;
  }
  if (!defaultFrom && fromAddresses.length) defaultFrom = fromAddresses[0] ?? null;

  return {
    fromAddresses,
    defaultFrom,
  };
}

// Guarantees the single settings row exists, seeding it from the env on first
// creation. Runs on the given connection so mutations can lock the fresh row.
async function ensureRow(conn: typeof sql): Promise<void> {
  const seed = seedFromEnv();
  await conn`
    INSERT INTO settings (id, from_addresses, default_from)
    VALUES (1, ${JSON.stringify(seed.fromAddresses)}::jsonb, ${seed.defaultFrom})
    ON CONFLICT (id) DO NOTHING
  `;
}

type SettingsRow = { from_addresses: unknown; default_from: string | null };

function rowToSettings(row: SettingsRow | undefined): Settings {
  if (!row) return seedFromEnv();
  return normalize({
    fromAddresses: asJson<string[]>(row.from_addresses, []),
    defaultFrom: row.default_from,
  });
}

export async function getSettings(): Promise<Settings> {
  await ensureRow(sql);
  const rows = (await sql`SELECT from_addresses, default_from FROM settings WHERE id = 1`) as SettingsRow[];
  return rowToSettings(rows[0]);
}

// Read-modify-write under a row lock so two concurrent settings edits can't
// clobber each other (the old file store used an in-process queue for this).
async function mutate(fn: (s: Settings) => void): Promise<Settings> {
  return sql.begin(async (tx) => {
    await ensureRow(tx);
    const rows = (await tx`
      SELECT from_addresses, default_from FROM settings WHERE id = 1 FOR UPDATE
    `) as SettingsRow[];
    const s = rowToSettings(rows[0]);
    fn(s);
    await tx`
      UPDATE settings
      SET from_addresses = ${JSON.stringify(s.fromAddresses)}::jsonb,
          default_from   = ${s.defaultFrom}
      WHERE id = 1
    `;
    return s;
  });
}

export function addFromAddress(address: string): Promise<Settings> {
  const clean = address.trim();
  if (!isValidAddress(clean)) return Promise.reject(new Error("Invalid email address"));
  return mutate((s) => {
    if (!s.fromAddresses.some((a) => bareAddress(a) === bareAddress(clean))) {
      s.fromAddresses.push(clean);
    }
    if (!s.defaultFrom) s.defaultFrom = s.fromAddresses[0] ?? null;
  });
}

export function removeFromAddress(address: string): Promise<Settings> {
  const key = bareAddress(address);
  return mutate((s) => {
    s.fromAddresses = s.fromAddresses.filter((a) => bareAddress(a) !== key);
    if (s.defaultFrom && bareAddress(s.defaultFrom) === key) {
      s.defaultFrom = s.fromAddresses[0] ?? null;
    }
  });
}

export function setDefaultFrom(address: string): Promise<Settings> {
  return mutate((s) => {
    const match = s.fromAddresses.find((a) => bareAddress(a) === bareAddress(address));
    if (!match) throw new Error("Address is not in the list");
    s.defaultFrom = match;
  });
}

// The address a message should actually be sent from: honour the caller's
// choice if it's allowlisted, else fall back to the default, else the env seed.
export async function resolveFrom(requested?: string | null): Promise<string> {
  const s = await getSettings();
  if (requested) {
    const match = s.fromAddresses.find((a) => bareAddress(a) === bareAddress(requested));
    if (match) return match;
  }
  if (s.defaultFrom) return s.defaultFrom;
  if (s.fromAddresses[0]) return s.fromAddresses[0];
  return parseAddressList(process.env.SEND_FROM)[0] ?? "";
}

// Every bare address that counts as "us", so threading can pick out the other
// party in a conversation regardless of which of our addresses was involved.
export async function getMyAddresses(): Promise<string[]> {
  const s = await getSettings();
  const set = new Set<string>();
  for (const a of [...s.fromAddresses, ...parseAddressList(process.env.SEND_FROM)]) {
    const bare = bareAddress(a);
    if (bare) set.add(bare);
  }
  return [...set];
}
