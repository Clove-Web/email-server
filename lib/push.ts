/* lib/push.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import * as webpush from "web-push";
import type { PushSubscription } from "web-push";
import { sql, asJson } from "./db";

// Web-push subscriptions now live in Postgres (push_subscriptions) rather than
// subscriptions.json. Each row is keyed by the subscription's unique endpoint.

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:admin@localhost";

// Push is entirely optional: without VAPID keys the endpoints still respond,
// they just report "not configured" instead of 500-ing.
export function pushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}

export function vapidPublicKey(): string {
  return VAPID_PUBLIC;
}

let vapidReady = false;
function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  vapidReady = true;
  return true;
}

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

function isSubscription(x: unknown): x is PushSubscription {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return typeof s.endpoint === "string" && !!s.keys && typeof s.keys === "object";
}

// Endpoint is the stable unique id for a subscription, so we upsert on it.
export async function addSubscription(sub: PushSubscription): Promise<void> {
  if (!isSubscription(sub)) throw new Error("Invalid subscription");
  await sql`
    INSERT INTO push_subscriptions (endpoint, sub)
    VALUES (${sub.endpoint}, ${JSON.stringify(sub)}::jsonb)
    ON CONFLICT (endpoint) DO UPDATE SET sub = EXCLUDED.sub
  `;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

export async function listSubscriptions(): Promise<PushSubscription[]> {
  const rows = (await sql`SELECT sub FROM push_subscriptions`) as Array<{ sub: unknown }>;
  return rows
    .map((r) => asJson<unknown>(r.sub, null))
    .filter(isSubscription);
}

export async function subscriptionCount(): Promise<number> {
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM push_subscriptions`) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

// Fans a payload out to every registered device. Subscriptions the push
// service reports as gone (404/410) are pruned so the table doesn't rot.
export async function sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!ensureVapid()) return { sent: 0, pruned: 0 };

  const subs = await listSubscriptions();
  const data = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data);
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint);
        } else {
          console.error("Push send failed", status ?? "", (err as { body?: string })?.body ?? err);
        }
      }
    }),
  );

  for (const endpoint of dead) await removeSubscription(endpoint);
  return { sent, pruned: dead.length };
}
