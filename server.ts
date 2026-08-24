/* server.ts
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for the full licence text.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Resend } from "resend";
import {
  addEmail,
  getEmail,
  listEmails,
  listByThreadKey,
  createDraft,
  updateDraft,
  deleteDraft,
  deleteEmail,
  deleteByThreadKey,
  type Folder,
  type StoredEmail,
  type StoredAttachment,
} from "./lib/store";
import {
  readAttachment,
  saveAttachment,
  deleteAttachment,
  toResendAttachment,
  persistInboundAttachments,
} from "./lib/attachments";
import {
  createSession,
  isValidSession,
  sessionUser,
  destroySession,
  savePending,
  takePending,
} from "./lib/auth";
import {
  initOidc,
  buildAuthUrl,
  completeLogin,
  endSessionUrl,
} from "./lib/oidc";
import {
  isAdmin,
  ensureUser,
  addressesFor,
  allAddresses,
  ownerForRecipients,
  canAccessOwner,
  resolveFromFor,
  dashboardState,
  mailDomain,
  assignAddress,
  unassignAddress,
  initOwners,
} from "./lib/owners";
import { initDb } from "./lib/db";
import { bareAddress } from "./lib/settings";
import {
  pushConfigured,
  vapidPublicKey,
  addSubscription,
  removeSubscription,
  subscriptionCount,
  sendToAll,
} from "./lib/push";
import type { PushSubscription } from "web-push";

// Attachments the frontend uploads arrive as base64; this turns them into
// StoredAttachment rows on disk and, in parallel, the shape Resend wants.
type UploadedAttachment = { filename: string; contentType: string; content: string };

async function persistUploads(uploads: UploadedAttachment[] | undefined): Promise<StoredAttachment[]> {
  if (!uploads?.length) return [];
  return Promise.all(uploads.map((u) => saveAttachment(u.filename, u.contentType, u.content)));
}

// A draft's attachment list, once loaded back into the compose form, is a
// mix of already-stored attachments (only an id/filename/contentType/size —
// no bytes) and freshly-picked files (base64 content, no id yet). Only the
// latter need to be written to disk; the former are kept as-is.
type MixedAttachment =
  | { id: string; filename: string; contentType: string; size: number }
  | UploadedAttachment;

async function resolveAttachments(items: MixedAttachment[] | undefined): Promise<StoredAttachment[]> {
  if (!items?.length) return [];
  const resolved = await Promise.all(
    items.map((item) =>
      "id" in item && item.id
        ? Promise.resolve(item as StoredAttachment)
        : saveAttachment((item as UploadedAttachment).filename, (item as UploadedAttachment).contentType, (item as UploadedAttachment).content)
    )
  );
  return resolved;
}

async function toResendAttachments(attachments: StoredAttachment[]) {
  const resolved = await Promise.all(attachments.map(toResendAttachment));
  return resolved.filter((a): a is { filename: string; content: string } => a !== null);
}

function parseFolder(value: string | undefined): Folder | undefined {
  return value === "inbox" || value === "sent" || value === "drafts" ? value : undefined;
}

const resend = new Resend(process.env.RESEND_API_KEY);
const webhookSecret = process.env.RESEND_WEBHOOK_SECRET ?? "";
// Last-resort fallback only (settings.json is the real source of from-addresses).
// SEND_FROM may be a comma/newline list now, so take the first entry.
const sendFrom = (process.env.SEND_FROM ?? "").split(/[,\n]/)[0]?.trim() ?? "";
// Cookies are only marked Secure in production (behind the TLS proxy).
const cookieSecure = process.env.COOKIE_SECURE === "true";

// --- Threading helpers ---
// bareAddress lives in lib/settings so the address-matching logic is shared.

// Groups inbound + outbound messages into one conversation using
// subject (Re:/Fwd: stripped) + the other party's address, since we
// can't always guarantee an unbroken Message-ID chain across clients.
// `myAddresses` is the set of bare addresses that count as "us", so the
// counterpart is picked correctly no matter which of our identities was used.
function computeThreadKey(subject: string, from: string, to: string[], myAddresses: string[]): string {
  const cleanSubject = (subject || "")
    .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
    .trim()
    .toLowerCase();

  const me = new Set(myAddresses);
  const participants = [bareAddress(from), ...to.map(bareAddress)]
    .filter((addr) => addr && !me.has(addr))
    .sort();

  const counterpart = participants[0] ?? bareAddress(from);
  return `${cleanSubject}::${counterpart}`;
}

// Picks which of the acting user's addresses a reply/forward comes from: their
// explicit choice if they own it, otherwise whichever of their addresses the
// original message involved, otherwise their first address.
function pickReplyFrom(user: string, original: StoredEmail, requested?: string | null): string {
  const owned = addressesFor(user);
  const inOwned = (addr: string | undefined | null) =>
    owned.find((a) => bareAddress(a) === bareAddress(addr));

  if (requested) {
    const match = inOwned(requested);
    if (match) return match;
  }
  const targets = original.direction === "inbound" ? original.to : [original.from];
  for (const t of targets) {
    const match = inOwned(t);
    if (match) return match;
  }
  return owned[0] ?? sendFrom;
}

function buildReferences(original: { references: string | null; messageId: string | null }): string {
  const prior = original.references ? original.references.split(/\s+/).filter(Boolean) : [];
  if (original.messageId) prior.push(original.messageId);
  return prior.join(" ");
}

// --- Deletion / image helpers ---

// Removes the on-disk bytes for every attachment on the given emails. Safe to
// call with rows that have no attachments or metadata-only ones (id === "").
async function purgeAttachmentFiles(emails: StoredEmail[]): Promise<void> {
  const ids = emails.flatMap((e) => e.attachments).map((a) => a.id).filter(Boolean);
  await Promise.all(ids.map((id) => deleteAttachment(id)));
}

// An inline image in an HTML body is referenced as <img src="cid:CONTENT-ID">.
// This rewrites those refs to point at our own attachment endpoint so the
// browser can actually load them, and flags which attachments were consumed
// inline so the UI can avoid also listing them as separate downloads.
type ServableAttachment = StoredAttachment & { inline?: boolean };
type ServableEmail = Omit<StoredEmail, "attachments"> & { attachments: ServableAttachment[] };

function inlineCidImages(email: StoredEmail): ServableEmail {
  const attachments: ServableAttachment[] = email.attachments.map((a) => ({ ...a }));

  const byContentId = new Map<string, StoredAttachment>();
  for (const a of email.attachments) {
    if (a.id && a.contentId) byContentId.set(a.contentId.toLowerCase(), a);
  }

  if (!email.html || !email.html.includes("cid:") || byContentId.size === 0) {
    return {
      ...email,
      attachments
    };
  }

  const usedIds = new Set<string>();
  const html = email.html.replace(/cid:([^"'\s>)]+)/gi, (whole, rawId: string) => {
    const key = rawId.replace(/^<|>$/g, "").trim().toLowerCase();
    const match = byContentId.get(key);
    // unknown cid — leave as-is (shows a broken image)
    if (!match) return whole;
    usedIds.add(match.id);
    return `/api/emails/${email.id}/attachments/${match.id}?inline=1`;
  });

  return {
    ...email,
    html,
    attachments: attachments.map((a) => (usedIds.has(a.id) ? {
      ...a,
      inline: true
    } : a)),
  };
}

// `user` is the logged-in username, set by the auth gate for every protected
// route so handlers can scope data to (or authorise against) the right person.
const app = new Hono<{ Variables: { user: string } }>();

// --- Auth gate ---
// Everything requires a valid session except: the webhook (Resend
// authenticates via signature, not cookies) and the login page/assets.
const PUBLIC_PATHS = new Set([
  "/login",
  "/login.html",
  "/login.js",
  "/style.css",
  "/favicon.ico",
  "/apple-touch-icon.png",
  // PocketID (OIDC) sign-in start + redirect target.
  "/auth/login",
  "/auth/callback",
  // Service worker + manifest must be fetchable for PWA install / push to
  // register cleanly; neither exposes anything sensitive.
  "/sw.js",
  "/manifest.webmanifest",
]);

app.use("/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/webhook/inbound" || PUBLIC_PATHS.has(path)) {
    return next();
  }

  const token = getCookie(c, "session");
  const user = sessionUser(token);
  if (!user) {
    if (path.startsWith("/api/")) return c.json({ error: "Unauthorized" }, 401);
    return c.redirect("/login");
  }

  c.set("user", user);
  return next();
});

app.get("/login", async (c) => {
  return c.html(await Bun.file("./public/login.html").text());
});

// --- PocketID (OIDC) login ---
app.get("/auth/login", async (c) => {
  try {
    const from = c.req.query("from") || "/inbox";
    const { url, pending } = await buildAuthUrl(from);
    const id = savePending(pending);
    setCookie(c, "login", id, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 600,
    });
    return c.redirect(url);
  } catch (err) {
    console.error("OIDC login start failed", err);
    return c.text("Login is temporarily unavailable.", 500);
  }
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const err = c.req.query("error");
  if (err) return c.text(`Login failed: ${err}`, 401);

  const pending = takePending(getCookie(c, "login"));
  deleteCookie(c, "login", { path: "/" });

  if (!pending || !code || !stateParam || stateParam !== pending.state) {
    return c.redirect("/login");
  }

  try {
    const { username } = await completeLogin(code, pending);
    ensureUser(username); // guarantees they own username@domain
    const token = createSession(username);
    setCookie(c, "session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.redirect(pending.returnTo);
  } catch (e) {
    console.error("OIDC callback error", e);
    return c.text("Login failed.", 401);
  }
});

// These are client-side "routes" — the SPA in public/app.js reads the path
// to decide which folder to show and updates it via history.pushState.
// The server just needs to hand back the same shell for all of them.
app.get("/", async (c) => c.html(await Bun.file("./public/index.html").text()));
app.get("/inbox", async (c) => c.html(await Bun.file("./public/index.html").text()));
app.get("/sent", async (c) => c.html(await Bun.file("./public/index.html").text()));
app.get("/drafts", async (c) => c.html(await Bun.file("./public/index.html").text()));
app.get("/settings", async (c) => c.html(await Bun.file("./public/settings.html").text()));

app.post("/api/logout", async (c) => {
  destroySession(getCookie(c, "session"));
  deleteCookie(c, "session", { path: "/" });
  // Frontend may redirect here to also end the PocketID SSO session.
  return c.json({ ok: true, endSession: endSessionUrl() });
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({
    username: user,
    displayName: user,
    isAdmin: isAdmin(user),
    addresses: addressesFor(user),
  });
});

// --- Static frontend ---
app.use("/*", serveStatic({ root: "./public" }));

// --- Inbound webhook (Resend calls this when an email arrives) ---
app.post("/webhook/inbound", async (c) => {
  const payload = await c.req.text();

  let event: any;
  try {
    event = resend.webhooks.verify({
      payload,
      headers: {
        id: c.req.header("svix-id") ?? "",
        timestamp: c.req.header("svix-timestamp") ?? "",
        signature: c.req.header("svix-signature") ?? "",
      },
      webhookSecret,
    });
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return c.text("Invalid signature", 401);
  }

  if (event.type !== "email.received") {
    return c.json({
      ok: true,
      ignored: event.type
    });
  }

  const emailId = event.data.email_id;

  // Webhook payload is metadata only — fetch the actual body separately
  const { data: full, error } = await resend.emails.receiving.get(emailId);
  if (error || !full) {
    console.error("Failed to fetch received email content", error);
    return c.json({ ok: false }, 500);
  }

  const subject = full.subject ?? "(no subject)";
  const to = full.to ?? [];
  const inReplyTo = full.headers?.["in-reply-to"] ?? null;
  const references = full.headers?.["references"] ?? null;
  const attachments = await persistInboundAttachments(full.attachments ?? []);
  const myAddresses = allAddresses().map(bareAddress);
  const owner = ownerForRecipients(to);

  await addEmail({
    id: full.id,
    from: full.from,
    to,
    subject,
    html: full.html ?? null,
    text: full.text ?? null,
    receivedAt: full.created_at,
    attachments,
    direction: "inbound",
    status: "sent",
    messageId: full.message_id ?? null,
    inReplyTo,
    references,
    threadKey: computeThreadKey(subject, full.from, to, myAddresses),
    owner,
  });

  // Best-effort push. Never let a notification error fail the webhook —
  // Resend would otherwise retry delivery of an email we already stored.
  try {
    await sendToAll({
      title: full.from ? `New email from ${full.from}` : "New email",
      body: subject,
      url: "/inbox",
      tag: full.id,
    });
  } catch (err) {
    console.error("Push notification failed", err);
  }

  return c.json({ ok: true });
});

// --- API for the frontend ---
app.get("/api/emails", async (c) => {
  const user = c.get("user");
  const folder = parseFolder(c.req.query("folder"));
  // Admins see every mailbox; everyone else only their own.
  const emails = await listEmails(folder, isAdmin(user) ? undefined : user);
  return c.json(emails);
});

// --- Attachment download ---
app.get("/api/emails/:id/attachments/:attachmentId", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const attachmentId = c.req.param("attachmentId");
  const meta = email.attachments.find((a) => a.id === attachmentId);
  if (!meta || !meta.id) return c.json({ error: "Not found" }, 404);

  const bytes = await readAttachment(meta.id);
  if (!bytes) return c.json({ error: "Not found" }, 404);

  // ?inline=1 is used for image previews and rewritten cid: images, which need
  // to render in-page rather than trigger a download.
  const disposition = c.req.query("inline") === "1" ? "inline" : "attachment";

  return new Response(bytes, {
    headers: {
      "Content-Type": meta.contentType,
      "Content-Disposition": `${disposition}; filename="${meta.filename.replace(/"/g, "")}"`,
      "Content-Length": String(meta.size),
    },
  });
});

app.get("/api/emails/:id", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(inlineCidImages(email));
});

// --- Delete a single message (works in any folder) ---
app.delete("/api/emails/:id", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const removed = await deleteEmail(email.id);
  if (removed) await purgeAttachmentFiles([removed]);
  return c.json({ ok: true });
});

// --- Delete an entire conversation at once ---
app.delete("/api/emails/:id/thread", async (c) => {
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(c.get("user"), original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const removed = await deleteByThreadKey(original.threadKey);
  await purgeAttachmentFiles(removed);
  return c.json({
    ok: true,
    count: removed.length
  });
});

// --- Single-file upload ---
// The compose form uploads each attachment here as it's picked, then sends
// only the returned id on submit. This keeps the eventual /api/send body tiny
// (references, not megabytes of base64), so several/large attachments no longer
// blow past the request-size limit on the proxy in front of us.
app.post("/api/uploads", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.content || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }
  const stored = await saveAttachment(
    typeof body.filename === "string" ? body.filename : "attachment",
    typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
    body.content
  );
  return c.json(stored);
});

app.post("/api/send", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.to || !body?.subject || !body?.html) {
    return c.json({ error: "to, subject, and html are required" }, 400);
  }

  const user = c.get("user");
  const from = resolveFromFor(user, body.from);
  if (!from) return c.json({ error: "You have no send-from address." }, 400);
  // resolveAttachments accepts both pre-uploaded refs (id only) and, as a
  // fallback, inline base64 — so this works whether or not the upload step ran.
  const stored = await resolveAttachments(body.attachments);
  const resendAttachments = await toResendAttachments(stored);

  const { data, error } = await resend.emails.send({
    from,
    to: body.to,
    subject: body.subject,
    html: body.html,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  const to = [body.to];
  const myAddresses = allAddresses().map(bareAddress);
  await addEmail({
    id: data.id,
    from,
    to,
    subject: body.subject,
    html: body.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: stored,
    direction: "outbound",
    status: "sent",
    messageId: null, // Resend doesn't hand back the RFC Message-ID it assigned
    inReplyTo: null,
    references: null,
    threadKey: computeThreadKey(body.subject, from, to, myAddresses),
    owner: user,
  });

  return c.json(data);
});

// --- Reply: keeps the recipient's mail client threading correct via
// In-Reply-To / References, and groups the reply with the original
// in our own UI via threadKey ---
app.post("/api/emails/:id/reply", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body?.html) return c.json({ error: "html is required" }, 400);

  const to = body.to ?? original.from;
  const subject = /^\s*re\s*:/i.test(original.subject)
    ? original.subject
    : `Re: ${original.subject}`;

  const headers: Record<string, string> = {};
  if (original.messageId) {
    headers["In-Reply-To"] = original.messageId;
    headers["References"] = buildReferences(original);
  }

  const from = pickReplyFrom(user, original, body.from);
  const stored = await resolveAttachments(body.attachments);
  const resendAttachments = await toResendAttachments(stored);

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html: body.html,
    headers,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  await addEmail({
    id: data.id,
    from,
    to: [to],
    subject,
    html: body.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: stored,
    direction: "outbound",
    status: "sent",
    messageId: null,
    inReplyTo: original.messageId,
    references: headers["References"] ?? null,
    threadKey: original.threadKey,
    owner: original.owner, // reply belongs to the same mailbox as the thread
  });

  return c.json(data);
});

// --- Forward: for inbound mail, use Resend's built-in forward() so the
// original body + attachments are preserved exactly; for something we
// sent ourselves, just re-send the stored HTML to a new recipient ---
app.post("/api/emails/:id/forward", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body?.to) return c.json({ error: "to is required" }, 400);

  const from = pickReplyFrom(user, original, body.from);

  if (original.direction === "inbound") {
    const { data, error } = await resend.emails.receiving.forward({
      emailId: original.id,
      to: body.to,
      from,
    });
    if (error) return c.json({ error: error.message }, 400);
    return c.json(data);
  }

  const { data, error } = await resend.emails.send({
    from,
    to: body.to,
    subject: /^\s*fwd?\s*:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
    html: original.html ?? `<pre>${original.text ?? ""}</pre>`,
  });
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

// --- Full conversation for the detail view ---
app.get("/api/emails/:id/thread", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const thread = await listByThreadKey(original.threadKey, isAdmin(user) ? undefined : user);
  return c.json(thread.map(inlineCidImages));
});

// --- Drafts ---
// Stored as ordinary email rows with status "draft"; they don't hit
// Resend until explicitly sent via /api/drafts/:id/send.
app.post("/api/drafts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.subject && !body?.html && !body?.to) {
    return c.json({ error: "Nothing to save" }, 400);
  }

  const stored = await resolveAttachments(body.attachments);
  const draft = await createDraft({
    to: body.to ? [body.to].flat() : [],
    subject: body.subject ?? "",
    html: body.html ?? "",
    from: typeof body.from === "string" ? body.from : undefined,
    attachments: stored,
    owner: c.get("user"),
  });

  return c.json(draft);
});

app.put("/api/drafts/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);

  // Only the owner (or an admin) may edit a draft.
  const existing = await getEmail(c.req.param("id"));
  if (!existing || existing.status !== "draft" || !canAccessOwner(user, existing.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const stored = await resolveAttachments(body.attachments);
  const draft = await updateDraft(c.req.param("id"), {
    to: body.to ? [body.to].flat() : [],
    subject: body.subject ?? "",
    html: body.html ?? "",
    from: typeof body.from === "string" ? body.from : undefined,
    attachments: stored,
    owner: existing.owner,
  });

  if (!draft) return c.json({ error: "Not found" }, 404);
  return c.json(draft);
});

app.delete("/api/drafts/:id", async (c) => {
  const draft = await getEmail(c.req.param("id"));
  if (!draft || draft.status !== "draft" || !canAccessOwner(c.get("user"), draft.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  await deleteDraft(draft.id);
  await purgeAttachmentFiles([draft]);
  return c.json({ ok: true });
});

app.post("/api/drafts/:id/send", async (c) => {
  const user = c.get("user");
  const draft = await getEmail(c.req.param("id"));
  if (!draft || draft.status !== "draft" || !canAccessOwner(user, draft.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!draft.to.length || !draft.subject || !draft.html) {
    return c.json({ error: "to, subject, and html are required" }, 400);
  }

  const from = resolveFromFor(draft.owner, draft.from || undefined);
  const resendAttachments = await toResendAttachments(draft.attachments);

  const { data, error } = await resend.emails.send({
    from,
    to: draft.to,
    subject: draft.subject,
    html: draft.html,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  const myAddresses = allAddresses().map(bareAddress);
  await deleteDraft(draft.id);
  await addEmail({
    id: data.id,
    from,
    to: draft.to,
    subject: draft.subject,
    html: draft.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: draft.attachments,
    direction: "outbound",
    status: "sent",
    messageId: null,
    inReplyTo: null,
    references: null,
    threadKey: computeThreadKey(draft.subject, from, draft.to, myAddresses),
    owner: draft.owner,
  });

  return c.json(data);
});

// --- Settings API ---
// Send-from addresses are now derived from ownership (owners.json), so this is
// read-only: it just reports which addresses the current user may send as.
app.get("/api/settings", (c) => {
  const addrs = addressesFor(c.get("user"));
  // domain lets the settings page show real "username@domain" hints instead
  // of a placeholder, without every user needing the admin-only owners route.
  return c.json({ fromAddresses: addrs, defaultFrom: addrs[0] ?? null, domain: mailDomain() });
});

// --- Ownership management (admin only) ---
// Powers the dashboard panel where an admin reserves addresses for users.
app.get("/api/owners", (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(dashboardState());
});

app.post("/api/owners/assign", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.username || !body?.address) {
    return c.json({ error: "username and address are required" }, 400);
  }
  try {
    return c.json(assignAddress(String(body.username), String(body.address)));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/owners/unassign", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.username || !body?.address) {
    return c.json({ error: "username and address are required" }, 400);
  }
  return c.json(unassignAddress(String(body.username), String(body.address)));
});

// --- Web Push API ---
// The client needs the VAPID public key to build a subscription, then POSTs
// the resulting subscription here so the webhook can notify it later.
app.get("/api/push/status", async (c) =>
  c.json({
    configured: pushConfigured(),
    publicKey: vapidPublicKey(),
    count: await subscriptionCount(),
  })
);

app.post("/api/push/subscribe", async (c) => {
  const body = await c.req.json().catch(() => null);
  const sub = body?.subscription ?? body;
  if (!sub?.endpoint || !sub?.keys) return c.json({ error: "Invalid subscription" }, 400);
  await addSubscription(sub as PushSubscription);
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = await c.req.json().catch(() => null);
  const endpoint = body?.endpoint ?? body?.subscription?.endpoint;
  if (!endpoint || typeof endpoint !== "string") {
    return c.json({ error: "endpoint is required" }, 400);
  }
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => {
  if (!pushConfigured()) {
    return c.json({ error: "Push is not configured on the server." }, 400);
  }
  const result = await sendToAll({
    title: "Test notification",
    body: "Your inbox notifications are working.",
    url: "/inbox",
    tag: "mailbox-test",
  });
  return c.json(result);
});

// Create tables if needed and hydrate the ownership cache from Postgres before
// we start serving, so the first request already has schema and config ready.
await initDb();
await initOwners();

// Fail fast if PocketID isn't reachable / configured, rather than only at login.
await initOidc();

const port = process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : 3000;
console.log(`Listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
