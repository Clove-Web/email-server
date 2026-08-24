/* lib/attachments.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { sql, asBytes } from "./db";
import type { StoredAttachment } from "./store";

/*
 * Attachment bytes now live in Postgres (the `attachments.bytes` bytea column)
 * rather than as loose files on a data volume. Rows are created up front — when
 * a person uploads a file while composing, or when an inbound webhook is
 * processed — with a NULL email_id, then linked to their email once it's saved
 * (see lib/store: addEmail / createDraft / updateDraft).
 */

// Saves raw content and returns the metadata that gets stored on the email
// record. Used both for files a person attaches when composing and for
// attachments pulled off an inbound webhook payload.
export async function saveAttachment(
  filename: string,
  contentType: string,
  base64Content: string,
  contentId?: string | null,
): Promise<StoredAttachment> {
  const id = crypto.randomUUID();
  const bytes = Buffer.from(base64Content, "base64");
  const cid = normalizeContentId(contentId);
  const name = filename || "attachment";
  const type = contentType || "application/octet-stream";
  await sql`
    INSERT INTO attachments (id, email_id, filename, content_type, size, content_id, bytes)
    VALUES (${id}, NULL, ${name}, ${type}, ${bytes.length}, ${cid}, ${bytes})
  `;
  return { id, filename: name, contentType: type, size: bytes.length, contentId: cid };
}

// A metadata-only attachment: we know its name/type but the webhook gave us no
// bytes to store. It still gets a row (so it can be listed on the email) but
// with a NULL body, so downloads 404 just like before.
async function saveAttachmentMeta(
  filename: string,
  contentType: string,
  contentId: string | null,
): Promise<StoredAttachment> {
  const id = crypto.randomUUID();
  const name = filename || "attachment";
  const type = contentType || "application/octet-stream";
  await sql`
    INSERT INTO attachments (id, email_id, filename, content_type, size, content_id, bytes)
    VALUES (${id}, NULL, ${name}, ${type}, 0, ${contentId}, NULL)
  `;
  return { id, filename: name, contentType: type, size: 0, contentId };
}

// A Content-ID header value is conventionally wrapped in angle brackets
// (e.g. "<abc123@mail>"), but the matching cid: reference in the HTML body
// isn't. Strip the brackets so the two sides compare cleanly.
export function normalizeContentId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^<|>$/g, "").trim();
  return trimmed || null;
}

export async function readAttachment(attachmentId: string): Promise<Uint8Array | null> {
  if (!attachmentId) return null;
  const rows = await sql`SELECT bytes FROM attachments WHERE id = ${attachmentId}`;
  const row = rows[0];
  if (!row) return null;
  return asBytes(row.bytes);
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  if (!attachmentId) return;
  await sql`DELETE FROM attachments WHERE id = ${attachmentId}`;
}

// Round-trips a stored attachment back into the shape Resend's send() API
// expects (base64 content alongside the filename).
export async function toResendAttachment(
  att: StoredAttachment,
): Promise<{ filename: string; content: string } | null> {
  const bytes = await readAttachment(att.id);
  if (!bytes) return null;
  return {
    filename: att.filename,
    content: Buffer.from(bytes).toString("base64"),
  };
}

// Resend's inbound webhook hands back attachment metadata plus base64
// content per attachment. The exact field names have shifted across Resend
// API versions, so this reads defensively and skips anything it can't
// make sense of rather than throwing and dropping the whole email.
export async function persistInboundAttachments(attachments: unknown): Promise<StoredAttachment[]> {
  if (!Array.isArray(attachments)) return [];

  const results: StoredAttachment[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const content = typeof a.content === "string" ? a.content : null;
    const filename =
      (typeof a.filename === "string" && a.filename) ||
      (typeof a.name === "string" && a.name) ||
      "attachment";
    const contentType =
      (typeof a.contentType === "string" && a.contentType) ||
      (typeof a.content_type === "string" && a.content_type) ||
      (typeof a.type === "string" && a.type) ||
      "application/octet-stream";
    // Content-ID lets us reconnect inline images to their cid: references in
    // the HTML body. Field name varies across Resend API versions.
    const contentId = normalizeContentId(
      (typeof a.contentId === "string" && a.contentId) ||
        (typeof a.content_id === "string" && a.content_id) ||
        (typeof a.cid === "string" && a.cid) ||
        null,
    );

    if (!content) {
      // No inline bytes available from the webhook — keep the metadata so the
      // UI can still show the filename, but there's nothing to download.
      try {
        results.push(await saveAttachmentMeta(filename, contentType, contentId));
      } catch (err) {
        console.error("Failed to persist inbound attachment metadata", filename, err);
      }
      continue;
    }

    try {
      results.push(await saveAttachment(filename, contentType, content, contentId));
    } catch (err) {
      console.error("Failed to persist inbound attachment", filename, err);
    }
  }
  return results;
}
