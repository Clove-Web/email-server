# pocketid-resend-email-server

A small self-hosted webmail front end for a [Resend](https://resend.com)
mailbox, with OIDC single sign-on and multi-user address ownership.

Resend handles the actual sending and receiving; this app gives you an inbox to
read it in. Written in TypeScript on [Bun](https://bun.sh) with
[Hono](https://hono.dev), storing everything in Postgres.

**Docker image:** `doughmination/pocketid-resend-email-server`

## Features

- Inbox, sent and drafts, with threaded conversations and attachments.
- Compose, reply and forward through Resend.
- OIDC sign-in — built against [Pocket ID](https://pocket-id.org), works with
  any compliant provider (Authentik, Keycloak, Zitadel…).
- Multi-user: everyone automatically owns `their-username@your-domain`, admins
  can reserve extra addresses (`support@`, `billing@`, …) for a user from the
  Settings page, and unclaimed mail falls to a catch-all user.
- Optional Web Push notifications, installable as a PWA.

## Requirements

- A domain you can set DNS records on.
- A Resend account with that domain verified, and inbound receiving enabled.
- An OIDC provider.
- A public HTTPS endpoint — both the OIDC callback and the Resend webhook need
  to reach the app. Put a reverse proxy (Caddy, Traefik, nginx…) in front of it.
- Docker, or Bun 1.x if you'd rather run it directly.

## Licence

MIT — see [LICENSE](LICENSE).
