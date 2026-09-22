# SendStack web (Vercel)

Next.js App Router runtime that preserves the existing `/api/*` SPA contract and targets
**Vercel + managed PostgreSQL + Resend Broadcasts**.

The Python test build under `../app` remains available for local comparison. This `web/`
app is the production-oriented runtime. Project docs: [`../docs/`](../docs/).

## Prerequisites

- Node.js 20+
- pnpm
- A PostgreSQL database (`DATABASE_URL`)

## Setup

```bash
cd web
cp .env.example .env.local
# edit DATABASE_URL and SENDSTACK_SESSION_SECRET
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000 and sign in. Default local seed credentials (when used) force a password change.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Local Next.js server |
| `pnpm build` | Production build |
| `pnpm db:migrate` | Apply incremental SQL migrations |
| `pnpm db:seed` | Seed admin + sample `.test` contacts |
| `pnpm test` | Unit tests |

## Delivery modes

- **Sandbox (default):** campaign launch processes recipients inside the request and writes local `messages` rows. No external email is sent.
- **Live Resend:** requires `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, verified domain/`SENDSTACK_FROM_EMAIL`, and `SENDSTACK_LIVE_SEND_ENABLED=true`. Keep live send locked until launch gates pass. Vercel **preview** deployments cannot live-send even if those vars are present.

Webhook endpoint: `POST /api/webhooks/resend`

## Vercel deploy checklist

1. Create a Vercel project with **Root Directory** set to `web` (use `web/vercel.json`).
2. Provision managed Postgres and set `DATABASE_URL`.
3. Set a strong `SENDSTACK_SESSION_SECRET` (≥32 chars, not the example default).
4. Set `SENDSTACK_PUBLIC_URL` to the HTTPS production origin.
5. Run `pnpm db:migrate` against production (and seed only with a non-default admin password).
6. Deploy. Confirm `/healthz` returns ok.
7. Add Resend keys later when ready; leave `SENDSTACK_LIVE_SEND_ENABLED=false` until domain + webhook gates pass.
8. Register webhook URL `https://<your-domain>/api/webhooks/resend` in Resend after setting `RESEND_WEBHOOK_SECRET`.

Preview deployments must not receive production Resend credentials.

## Cloudflare

Cloudflare remains DNS-only for the app hostname and Resend SPF/DKIM/DMARC records. It does not host this runtime.

## Production guards built into this app

- Startup env validation fails loudly in production on missing DB/session secret
- Secure cookies auto-enable on Vercel production / HTTPS public URL
- Preview environments cannot unlock live send
- Default admin password requires change before mutating APIs
- Migrations are tracked in `schema_migrations` and are idempotent
