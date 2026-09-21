# SendStack production handover: Vercel + PostgreSQL + Resend

## Decision

SendStack's selected production architecture is:

- **Application runtime:** Vercel
- **System of record:** managed PostgreSQL
- **Email delivery:** Resend Broadcasts
- **Audience model:** Resend Contacts assigned to Segments
- **DNS:** Cloudflare may remain the DNS host for the application and sending-domain records

The current runnable build is still a local test environment. It uses a persistent Python process, SQLite, and an in-process queue. It is safe for product testing but is not ready to deploy to Vercel or send through Resend.

## Production delivery contract

1. SendStack creates an immutable recipient snapshot from active, consented, unsuppressed contacts.
2. That snapshot is synchronized to a campaign-specific Resend Segment.
3. SendStack creates a Resend Broadcast as a draft and stores the returned provider ID before requesting delivery.
4. Resend queues and throttles the broadcast. SendStack does not run a long-lived delivery worker on Vercel.
5. Signed webhook events update the local recipient ledger and global suppression state.

Provider acceptance is **submitted**, not **delivered**. The UI must only show delivered after a verified delivery event.

## Fastest safe implementation sequence

### 1. Preserve the working test build

- Keep sandbox as the default and keep all external delivery fail-closed.
- Preserve the four composer formats: Visual builder, Rich text, Custom HTML, and Plain text.
- Freeze the current SQLite data before migration and record table counts and checksums.

### 2. Move the runtime and database

- Refactor the HTTP entry point for request-scoped Vercel execution without changing the existing `/api/*` browser contract.
- Move static files to the Vercel static output directory.
- Replace SQLite with pooled PostgreSQL connections and transactional state changes.
- Move login throttling, sessions, launch locks, and all queue state out of process memory.
- Add repeatable migrations and a one-time SQLite-to-PostgreSQL import with reconciliation.

### 3. Add the Resend provider boundary

- Keep the sandbox provider for previews and automated tests.
- Map SendStack lists and campaign snapshots to Resend Segments. Do not use deprecated Audiences.
- Store Resend contact, segment, import, broadcast, and email identifiers locally.
- Create the broadcast draft first, persist its ID, then submit that stored broadcast. Never create a second broadcast blindly after a timeout.
- Translate SendStack personalization and unsubscribe tokens only at the provider boundary.

### 4. Implement feedback and suppression

- Expose a public Resend webhook endpoint that reads the raw body and verifies all signature headers before parsing JSON.
- Store each provider event once using its unique event ID.
- Handle duplicate and out-of-order delivery events without regressing terminal states.
- Convert bounce, complaint, provider suppression, and unsubscribe events into immediate global SendStack suppressions.
- Never re-subscribe an opted-out contact during an ordinary sync.

### 5. Unlock live delivery only after verification

- Verify the sending domain and allowed From address.
- Register and test the production webhook.
- Complete backup and restore testing.
- Remove the default administrator password and require secure cookies over HTTPS.
- Run a small internal or explicitly consented canary before increasing volume.

## Server-only production configuration

The production implementation should consume these Vercel environment variables. They are intentionally not consumed by the current local server, so adding them today does not connect Resend.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled managed PostgreSQL connection |
| `RESEND_API_KEY` | Server-side provider access; never expose to browser code |
| `RESEND_WEBHOOK_SECRET` | Signature verification for the raw webhook request |
| `SENDSTACK_PUBLIC_URL` | HTTPS production origin used in links and callbacks |
| `SENDSTACK_SESSION_SECRET` | Production session signing/encryption secret |
| `SENDSTACK_FROM_EMAIL` | Verified production sender address |
| `SENDSTACK_LIVE_SEND_ENABLED` | Explicit kill switch; default must be `false` |

Preview deployments must remain in sandbox mode and must not receive production provider credentials.

## Launch gates

Live sending stays locked until every item below passes:

- PostgreSQL migration preserves row counts, IDs, consent, memberships, campaign content, statuses, and suppressions.
- Concurrent launch requests create at most one provider broadcast.
- A 10,000-recipient dry run against a fake provider produces no missing or duplicate recipients.
- Contact import and Segment counts reconcile exactly with the immutable recipient snapshot.
- Webhook signature, replay, duplicate, unknown-event, and out-of-order tests pass.
- Bounce, complaint, provider suppression, and unsubscribe each block the next campaign locally and at the provider boundary.
- Production and preview secrets are isolated; no API key or webhook secret appears in responses, browser bundles, logs, or audit details.
- The verified From address is enforced server-side.
- A tested emergency stop prevents new broadcasts.
- A controlled canary confirms the full send, delivery, feedback, and unsubscribe loop.

## Volume ramp

The business goal is 3,000–10,000 messages per day. Treat that as a steady-state target, not an immediate entitlement or deliverability guarantee.

Start with a small, engaged, consented segment. Increase volume only when authentication is valid, webhook processing is healthy, suppressions are synchronized, and bounce and complaint signals remain within the provider's acceptable range. Stop automatically when a safety threshold is exceeded.

## Product behavior that changes in production

- **Pause/resume:** local sandbox delivery may pause. Once a live broadcast is accepted, already-sent messages cannot be recalled. Production should offer cancel only while the provider can still stop remaining delivery.
- **Queue:** Resend owns the live delivery queue; SendStack owns the campaign intent, recipient snapshot, safety gate, and audit trail.
- **Deliveries:** local captures remain available for testing. Production delivery status comes from signed provider events.
- **Unsubscribe:** the provider unsubscribe link is authoritative at send time and must synchronize back to SendStack's global suppression list.

