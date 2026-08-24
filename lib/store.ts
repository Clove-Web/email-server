/* lib/store.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { sql, asJson } from "./db";

export type StoredAttachment = {
  // used to fetch the raw bytes back via lib/attachments
  id: string;
  filename: string;
  contentType: string;
  // bytes
  size: number;
  // RFC Content-ID for inline (cid:) images, if any
  contentId?: string | null;
};

export type Folder = "inbox" | "sent" | "drafts";

export type StoredEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  receivedAt: string;
  attachments: StoredAttachment[];
  direction: "inbound" | "outbound";
  // drafts live in the same table as real mail
  status: "sent" | "draft";
  // RFC Message-ID of this email, if known
  messageId: string | null;
  // Message-ID this email is replying to
  inReplyTo: string | null;
  // space-separated chain of Message-IDs
  references: string | null;
  // our own grouping key (subject + counterpart)
  threadKey: string;
  // which mailbox user this message belongs to (see lib/owners)
  owner: string;
};

// A draft doesn't have most of the threading/delivery metadata yet —
// callers only need to supply the fields a person can actually edit.
export type DraftInput = {
  to: string[];
  subject: string;
  html: string;
  attachments: StoredAttachment[];
  // chosen send-from address, resolved/validated at send time
  from?: string;
  inReplyTo?: string | null;
  references?: string | null;
  threadKey?: string | null;
  // the mailbox user saving the draft
  owner: string;
};

export function folderOf(email: Pick<StoredEmail, "direction" | "status">): Folder {
  if (email.status === "draft") return "drafts";
  return email.direction === "inbound" ? "inbox" : "sent";
}

// The attachment metadata for an email, aggregated as jsonb so a single query
// hands back a whole email plus its files. Bytes are deliberately excluded.
// A fresh fragment per call avoids reusing one Query object across statements.
const attachmentsJson = () => sql`
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',          a.id,
      'filename',    a.filename,
      'contentType', a.content_type,
      'size',        a.size,
      'contentId',   a.content_id
    ) ORDER BY a.seq)
    FROM attachments a
    WHERE a.email_id = e.id
  ), '[]'::jsonb)
`;

type EmailRow = {
  id: string;
  from_addr: string;
  to_addrs: unknown;
  subject: string;
  html: string | null;
  body_text: string | null;
  received_at: string;
  direction: string;
  status: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  thread_key: string;
  owner: string;
  attachments: unknown;
};

function rowToEmail(row: EmailRow): StoredEmail {
  return {
    id: row.id,
    from: row.from_addr,
    to: asJson<string[]>(row.to_addrs, []),
    subject: row.subject,
    html: row.html ?? null,
    text: row.body_text ?? null,
    receivedAt: row.received_at,
    attachments: asJson<StoredAttachment[]>(row.attachments, []),
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    status: row.status === "draft" ? "draft" : "sent",
    messageId: row.message_id ?? null,
    inReplyTo: row.in_reply_to ?? null,
    references: row.refs ?? null,
    threadKey: row.thread_key,
    owner: row.owner,
  };
}

// Point a set of already-persisted attachment rows at their email. Called after
// the email row exists (attachments are uploaded/persisted beforehand with a
// NULL email_id). Runs on the given connection so it can join a transaction.
async function linkAttachments(conn: typeof sql, emailId: string, attachments: StoredAttachment[]) {
  for (const att of attachments) {
    if (!att.id) continue;
    await conn`UPDATE attachments SET email_id = ${emailId} WHERE id = ${att.id}`;
  }
}

export async function addEmail(email: StoredEmail): Promise<StoredEmail> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO emails (
        id, from_addr, to_addrs, subject, html, body_text, received_at,
        direction, status, message_id, in_reply_to, refs, thread_key, owner
      ) VALUES (
        ${email.id}, ${email.from}, ${JSON.stringify(email.to ?? [])}::jsonb,
        ${email.subject ?? ""}, ${email.html}, ${email.text}, ${email.receivedAt},
        ${email.direction}, ${email.status}, ${email.messageId}, ${email.inReplyTo},
        ${email.references}, ${email.threadKey}, ${email.owner ?? ""}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await linkAttachments(tx, email.id, email.attachments ?? []);
  });
  return email;
}

// `owner` scopes the list to one user's mail; omit it (admins) to see all.
export async function listEmails(folder?: Folder, owner?: string) {
  const key = owner?.toLowerCase() ?? null;

  // Map a logical folder to its (status, direction) predicate.
  const rows = (await sql`
    SELECT
      e.id, e.from_addr, e.to_addrs, e.subject, e.received_at, e.direction,
      e.status, e.message_id, e.in_reply_to, e.refs, e.thread_key, e.owner,
      ${attachmentsJson()} AS attachments
    FROM emails e
    WHERE
      (${folder ?? null}::text IS NULL OR (
        (${folder ?? null}::text = 'drafts' AND e.status = 'draft') OR
        (${folder ?? null}::text = 'inbox'  AND e.status <> 'draft' AND e.direction = 'inbound') OR
        (${folder ?? null}::text = 'sent'   AND e.status <> 'draft' AND e.direction = 'outbound')
      ))
      AND (${key}::text IS NULL OR LOWER(e.owner) = ${key})
    ORDER BY e.seq DESC
  `) as EmailRow[];

  // Don't ship full HTML bodies to the list view (they aren't even selected).
  return rows.map((row) => {
    const { html, text, ...meta } = rowToEmail({ ...row, html: null, body_text: null });
    return meta;
  });
}

export async function getEmail(id: string): Promise<StoredEmail | null> {
  const rows = (await sql`
    SELECT
      e.id, e.from_addr, e.to_addrs, e.subject, e.html, e.body_text, e.received_at,
      e.direction, e.status, e.message_id, e.in_reply_to, e.refs, e.thread_key, e.owner,
      ${attachmentsJson()} AS attachments
    FROM emails e
    WHERE e.id = ${id}
    LIMIT 1
  `) as EmailRow[];
  return rows[0] ? rowToEmail(rows[0]) : null;
}

export async function findByMessageId(messageId: string): Promise<StoredEmail | null> {
  const rows = (await sql`
    SELECT
      e.id, e.from_addr, e.to_addrs, e.subject, e.html, e.body_text, e.received_at,
      e.direction, e.status, e.message_id, e.in_reply_to, e.refs, e.thread_key, e.owner,
      ${attachmentsJson()} AS attachments
    FROM emails e
    WHERE e.message_id = ${messageId}
    LIMIT 1
  `) as EmailRow[];
  return rows[0] ? rowToEmail(rows[0]) : null;
}

export async function listByThreadKey(threadKey: string, owner?: string): Promise<StoredEmail[]> {
  const key = owner?.toLowerCase() ?? null;
  const rows = (await sql`
    SELECT
      e.id, e.from_addr, e.to_addrs, e.subject, e.html, e.body_text, e.received_at,
      e.direction, e.status, e.message_id, e.in_reply_to, e.refs, e.thread_key, e.owner,
      ${attachmentsJson()} AS attachments
    FROM emails e
    WHERE e.thread_key = ${threadKey}
      AND (${key}::text IS NULL OR LOWER(e.owner) = ${key})
    ORDER BY e.received_at ASC
  `) as EmailRow[];
  return rows.map(rowToEmail);
}

// --- Drafts ---
// Drafts are ordinary StoredEmail rows with status "draft" and
// direction "outbound"; they're excluded from threads until sent.

export async function createDraft(input: DraftInput): Promise<StoredEmail> {
  const draft: StoredEmail = {
    id: crypto.randomUUID(),
    from: input.from ?? "",
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: input.attachments,
    direction: "outbound",
    status: "draft",
    messageId: null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    threadKey: input.threadKey ?? `draft::${crypto.randomUUID()}`,
    owner: input.owner,
  };
  await addEmail(draft);
  return draft;
}

export async function updateDraft(id: string, input: DraftInput): Promise<StoredEmail | null> {
  return sql.begin(async (tx) => {
    const existing = (await tx`
      SELECT id, from_addr, thread_key, owner, in_reply_to, refs
      FROM emails WHERE id = ${id} AND status = 'draft' LIMIT 1
    `) as Array<{
      from_addr: string;
      thread_key: string;
      owner: string;
      in_reply_to: string | null;
      refs: string | null;
    }>;
    const prev = existing[0];
    if (!prev) return null;

    const from = input.from ?? prev.from_addr;
    const receivedAt = new Date().toISOString();
    await tx`
      UPDATE emails SET
        to_addrs    = ${JSON.stringify(input.to ?? [])}::jsonb,
        subject     = ${input.subject},
        html        = ${input.html},
        from_addr   = ${from},
        received_at = ${receivedAt}
      WHERE id = ${id}
    `;

    // Reconcile attachments: drop rows that were on the draft but aren't in the
    // new set (freeing their bytes), then link whatever's in the new set.
    const current = (await tx`SELECT id FROM attachments WHERE email_id = ${id}`) as Array<{
      id: string;
    }>;
    const keep = new Set(input.attachments.map((a) => a.id).filter(Boolean));
    for (const row of current) {
      if (!keep.has(row.id)) {
        await tx`DELETE FROM attachments WHERE id = ${row.id}`;
      }
    }
    await linkAttachments(tx, id, input.attachments);

    return {
      id,
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: null,
      receivedAt,
      attachments: input.attachments,
      direction: "outbound",
      status: "draft",
      messageId: null,
      inReplyTo: prev.in_reply_to ?? null,
      references: prev.refs ?? null,
      threadKey: prev.thread_key,
      owner: prev.owner,
    } satisfies StoredEmail;
  });
}

export async function deleteDraft(id: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM emails WHERE id = ${id} AND status = 'draft' RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

// --- General deletion ---
// Unlike deleteDraft, these remove any row regardless of status and hand the
// removed record(s) back so the caller can clean up (attachment rows cascade
// away automatically via the FK, but the caller still gets the metadata).

export async function deleteEmail(id: string): Promise<StoredEmail | null> {
  const email = await getEmail(id);
  if (!email) return null;
  await sql`DELETE FROM emails WHERE id = ${id}`;
  return email;
}

export async function deleteByThreadKey(threadKey: string): Promise<StoredEmail[]> {
  const rows = (await sql`
    SELECT
      e.id, e.from_addr, e.to_addrs, e.subject, e.html, e.body_text, e.received_at,
      e.direction, e.status, e.message_id, e.in_reply_to, e.refs, e.thread_key, e.owner,
      ${attachmentsJson()} AS attachments
    FROM emails e
    WHERE e.thread_key = ${threadKey}
  `) as EmailRow[];
  if (rows.length === 0) return [];
  await sql`DELETE FROM emails WHERE thread_key = ${threadKey}`;
  return rows.map(rowToEmail);
}
