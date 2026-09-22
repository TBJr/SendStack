# Architecture

See also: [Product](product.md) · [Deployment](deployment.md)

## Production target

| Layer | Choice |
| --- | --- |
| Application runtime | Vercel (Next.js App Router under `web/`) |
| System of record | Managed PostgreSQL |
| Email delivery | Resend Broadcasts |
| Audience model | Resend Contacts assigned to campaign-specific Segments |
| DNS | Cloudflare may host DNS and SPF/DKIM/DMARC records only |

SendStack does **not** run a long-lived delivery worker on Vercel. Resend owns production queueing and throttling.

## Local runtimes

Two runnable surfaces exist in this repository:

1. **Python test build (`app/`)** — dependency-free local server with SQLite, an in-process worker, and sandbox capture by default. Useful for product testing; not the Vercel deployment.
2. **Next.js app (`web/`)** — production-oriented runtime with the same `/api/*` SPA contract, PostgreSQL, and request-scoped campaign processing. This is what deploys to Vercel.

Both default to sandbox delivery. External send paths are fail-closed until explicitly configured and unlocked.

## Production delivery contract

1. SendStack builds an immutable recipient snapshot from active, consented, unsuppressed contacts.
2. That snapshot syncs to a campaign-specific Resend Segment.
3. SendStack creates a Resend Broadcast as a draft, stores the provider ID, then submits that stored broadcast.
4. Resend queues and delivers; SendStack does not re-implement provider queueing.
5. Signed Resend webhooks update the local recipient ledger and global suppression state.

Provider acceptance is **submitted**, not **delivered**. The UI shows delivered only after a verified delivery event.

## Non-goals

These are intentionally out of scope for the selected architecture:

- Self-hosted Postfix or other client-controlled outbound MTA
- Direct-to-MX delivery from SendStack infrastructure
- Long-lived background workers on Vercel for mass send
- Multi-tenant SaaS in the MVP
- General-purpose mailbox / inbound human email hosting

## Operating range

The intended steady-state range is **3,000–10,000 messages per day after a staged ramp**. That is a target, not a day-one entitlement. Initial volume must use a small consented canary and increase only while bounce, complaint, and unsubscribe signals remain healthy.
