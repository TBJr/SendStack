# SendStack

This repository contains a runnable, dependency-free test build of the SendStack email marketing platform, plus a production-oriented Next.js app under `web/`. It is intentionally safe by default: messages are captured inside the application and no external email is sent.

The selected production target is **Vercel + managed PostgreSQL + Resend Broadcasts**. That target is visible under **Sending setup** in the application. It is a migration target—not an active transport in the Python test build.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/product.md`](docs/product.md) | Goals, roles, modules, and MVP boundaries |
| [`docs/architecture.md`](docs/architecture.md) | Production and local stacks, delivery contract |
| [`docs/deployment.md`](docs/deployment.md) | Vercel handover, launch gates, and env vars |
| [`web/README.md`](web/README.md) | Next.js app setup and Vercel deploy checklist |

## Run it now (legacy Python test build)

Requirements: Python 3.11 or newer.

```bash
./scripts/start.sh
```

Open <http://localhost:8080> and sign in with:

- Email: `admin@sendstack.local`
- Password: `ChangeMe123!`

The test build starts with three synthetic contacts on the reserved `.test` domain.

## Vercel app (`web/`)

The production-oriented runtime lives in [`web/`](web/). It is a Next.js App Router app that keeps the same SPA and `/api/*` contract, uses PostgreSQL, and processes sandbox campaigns without a long-lived worker.

```bash
cd web
cp .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open <http://localhost:3000>. See [`web/README.md`](web/README.md) for the Vercel Root Directory (`web`), production checklist, Resend env vars, and the live-send kill switch (`SENDSTACK_LIVE_SEND_ENABLED`, default `false`).

The Python server above remains the dependency-free local reference build; it is not the Vercel deployment.

## What can be tested

- Secure sign-in, expiring sessions, CSRF checks, and role-aware writes
- Contact entry, CSV import, deduplication, lists, and consent-source recording
- Campaign authoring in Visual builder, Rich text, Custom HTML, or Plain text mode, with personalization and responsive preview
- Test sends and asynchronous campaign execution
- Per-second and daily safety limits
- Global unsubscribe, hard-bounce, complaint, and manual suppressions
- A sandbox inbox with rendered-message inspection
- Campaign totals, delivery history, queue state, and an audit log
- Administrator-managed users, fixed least-privilege roles, session revocation, and permission-aware navigation

The default transport is `sandbox`. “Sandboxed” means captured locally; it does not mean delivered. If SMTP test mode is configured, “submitted” means the relay accepted the message, not that it reached an inbox.

## Roles and permissions

SendStack includes three built-in roles. Permissions are enforced by the server on every protected route; hiding an interface control is only a usability aid.

- **Administrator:** full access, including users, roles, audit history, and simulated delivery feedback.
- **Marketer:** manages lists, contacts, campaigns, controlled sends, deliveries, and manual suppressions. It cannot manage users or read the audit log.
- **Analyst:** read-only overview, sending readiness, list totals, and campaign reporting without recipient-level contact, delivery, or suppression data.

Administrators can create, update, disable, reactivate, and reset users under **Users & roles**. User deletion is intentionally unavailable so ownership and audit history remain intact. Role, status, and password changes revoke the affected user’s active sessions, and an administrator cannot demote or disable their own account.

## CSV format

The only required column is `email`. Optional columns are `first_name` and `last_name`.

```csv
email,first_name,last_name
person@example.test,Pat,Lee
```

Only use synthetic addresses or contacts with documented permission.

## Run the automated checks

```bash
./scripts/test.sh
```

## Selected production architecture

The live delivery path is:

1. Vercel hosts the web application and request-scoped API.
2. Managed PostgreSQL stores users, consent, lists, immutable recipient snapshots, provider IDs, delivery events, and global suppressions.
3. SendStack syncs eligible contacts to Resend Contacts and campaign-specific Segments.
4. SendStack creates and submits a Resend Broadcast; Resend owns production queueing and throttling.
5. Signed Resend webhooks reconcile sent, delivered, delayed, bounced, complained, suppressed, and unsubscribe events back into PostgreSQL.

Cloudflare may continue to host DNS and the authentication records for the sending domain. It does not replace the Vercel runtime or the Resend delivery provider.

The intended operating range is **3,000–10,000 messages per day after a staged ramp**, not a guaranteed day-one send rate. Initial volume must use a small consented canary and increase only while bounce, complaint, and unsubscribe signals remain healthy.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/deployment.md`](docs/deployment.md) for the full contract, implementation sequence, and handover checklist.

## Optional controlled SMTP test

SMTP mode is deliberately fail-closed. It requires authenticated STARTTLS, a verified From address, and an exact recipient allowlist. Copy `.env.example` into your own secret-management workflow and set the variables before starting the server.

```bash
SENDSTACK_DELIVERY_MODE=smtp \
SENDSTACK_SMTP_HOST=smtp.example.com \
SENDSTACK_SMTP_PORT=587 \
SENDSTACK_SMTP_USERNAME=your-user \
SENDSTACK_SMTP_PASSWORD=your-secret \
SENDSTACK_SMTP_FROM_EMAIL=verified-sender@example.com \
SENDSTACK_TEST_RECIPIENT_ALLOWLIST=owner@example.com \
./scripts/start.sh
```

Safety defaults for external tests are 1 message/second, 50 messages/day, and 10 recipients per campaign. Every SMTP recipient must be listed explicitly. SMTP failures are not automatically retried because a connection can fail after the relay accepted a message, making its outcome ambiguous.

## Docker

```bash
docker compose up --build
```

Data is stored under `./data` and survives restarts.

## Important boundary

This is the immediate functional-test build, not the final production release. The Python path uses SQLite, a persistent HTTP process, and one in-process worker. Those choices make local testing simple, but they are not compatible with a dependable Vercel production deployment.

This repository does **not** currently send through Resend by default and should not be presented as production-ready until live delivery is unlocked. Live send remains locked until the Resend adapter path, verified domain, signed webhooks, suppression sync, backup/restore, and administrator security controls are complete. The optional SMTP mode remains only for tightly controlled allowlisted tests and is not the planned mass-delivery architecture.
