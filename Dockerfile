# Dockerfile
# Copyright (c) 2026 Clove Nytrix Doughmination Twilight
# SPDX-License-Identifier: MIT
# See LICENSE in the project root for the full licence text.
FROM oven/bun:1 AS base
WORKDIR /app

LABEL org.opencontainers.image.title="pocketid-resend-email-server"
LABEL org.opencontainers.image.description="Self-hosted webmail on top of Resend, with OIDC single sign-on."
LABEL org.opencontainers.image.licenses="MIT"

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
# Match MAIL_PORT in your .env if you change this.
EXPOSE 4040

CMD ["bun", "run", "server.ts"]
