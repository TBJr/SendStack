# Product overview

See also: [Architecture](architecture.md) · [Deployment](deployment.md)

## Purpose

SendStack is a permission-based marketing email platform for campaign management, audience handling, and controlled outbound delivery. The MVP is a single-client application: users manage contacts and lists, author campaigns, launch sends through a provider boundary, and inspect delivery and suppression history.

Production delivery uses **Resend Broadcasts**. Local and preview environments stay sandboxed by default so no external email is sent until live send is explicitly unlocked.

## Goals

- Import, organize, and segment permission-based contacts with consent recorded at entry.
- Author responsive campaigns in Visual builder, Rich text, Custom HTML, or Plain text, with personalization and preview.
- Queue and send campaigns without blocking the web UI; in production, Resend owns delivery queueing.
- Enforce unsubscribe, hard-bounce, complaint, and manual suppressions before every send.
- Keep auditable campaign, delivery, and administrative history.
- Hand over a deployable Vercel + PostgreSQL application the client can operate.

## Roles

Permissions are enforced on every protected API route. Hiding a control in the UI is only a usability aid.

| Role | Access |
| --- | --- |
| **Administrator** | Full access: users, roles, audit history, suppressions, and simulated delivery feedback |
| **Marketer** | Lists, contacts, campaigns, controlled sends, deliveries, and manual suppressions; cannot manage users or read the audit log |
| **Analyst** | Read-only overview, sending readiness, list totals, and campaign reporting without recipient-level contact, delivery, or suppression data |

Administrators can create, update, disable, reactivate, and reset users. User deletion is unavailable so ownership and audit history remain intact. Role, status, and password changes revoke the affected user’s sessions. An administrator cannot demote or disable their own account.

## Core modules

| Module | Purpose |
| --- | --- |
| Contacts & lists | Audience membership, CSV import, deduplication, consent source |
| Campaigns | Authoring, personalization, test sends, launch, pause/cancel where supported |
| Delivery | Sandbox capture locally; Resend Broadcasts in production |
| Suppressions | Global unsubscribe, bounce, complaint, and manual blocks |
| Reporting | Campaign totals, delivery history, queue/provider state |
| Administration | Users, roles, sessions, audit log, sending setup |

## MVP boundaries

In scope: campaign management, consent-aware audiences, sandbox and provider-backed send, suppressions, reporting, and admin controls.

Out of scope for MVP: multi-tenant SaaS, CRM, SMS/WhatsApp, complex journey automation, inbound human mailboxes, and self-hosted direct-to-MX MTA operation.

## Safety defaults

- Sandbox is the default transport; messages are captured locally and are not delivered.
- Live Resend send requires verified domain/From, webhook verification, and `SENDSTACK_LIVE_SEND_ENABLED=true`.
- Preview deployments must not receive production provider credentials and cannot unlock live send.
- Optional SMTP test mode (Python build only) is fail-closed: authenticated STARTTLS, verified From, and an exact recipient allowlist.
