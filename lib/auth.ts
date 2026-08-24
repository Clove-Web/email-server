/* lib/auth.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { randomUUID } from "node:crypto";
import type { Pending } from "./oidc";

// 7 days
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
// A login redirect round-trip should take seconds; 10 minutes is generous.
const PENDING_TTL_MS = 1000 * 60 * 10;

// In-memory is enough for a single-instance mailbox — sessions reset on
// restart, which just means logging back in via PocketID.
interface SessionRow {
  expiresAt: number;
  username: string;
}
// token -> session
const sessions = new Map<string, SessionRow>();

export function createSession(username: string): string {
  const token = randomUUID();
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, username });
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  return sessionUser(token) !== null;
}

/** The logged-in username for a session token, or null if invalid/expired. */
export function sessionUser(token: string | undefined): string | null {
  if (!token) return null;
  const row = sessions.get(token);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return row.username;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

// --- In-flight OIDC logins ---
// PKCE state has to survive the redirect to PocketID and back. We key it by a
// short-lived `login` cookie rather than trusting anything in the URL.
interface PendingRow extends Pending {
  expiresAt: number;
}
const pendings = new Map<string, PendingRow>();

export function savePending(p: Pending): string {
  const id = randomUUID();
  pendings.set(id, { ...p, expiresAt: Date.now() + PENDING_TTL_MS });
  return id;
}

export function takePending(id: string | undefined): Pending | null {
  if (!id) return null;
  const row = pendings.get(id);
  if (!row) return null;
  pendings.delete(id); // single use
  if (Date.now() > row.expiresAt) return null;
  const { expiresAt, ...pending } = row;
  return pending;
}
