import { createHash, randomBytes } from "crypto";
import { json } from "./http";
import { config } from "./config";
import { query } from "./db";
import { hashPassword, normalizeEmail, validEmail, verifyPassword } from "./ids";
import { sendResendEmail } from "./providers/resend";
import { applySuppression } from "./suppressions";

const ADMIN_PERMISSIONS = [
  "overview.view", "sending.view", "lists.view", "lists.manage", "contacts.view",
  "contacts.manage", "campaigns.view", "campaigns.manage", "campaigns.send", "deliveries.view",
  "deliveries.feedback", "suppressions.view", "suppressions.manage", "audit.view", "users.view", "users.manage",
];

const ROLE_DEFINITIONS = [
  { id: "admin", label: "Administrator", description: "Full system control, including access management and audit history.", permissions: ADMIN_PERMISSIONS },
  { id: "marketer", label: "Marketer", description: "Manages audiences, campaigns, controlled sends, and suppressions.", permissions: ["overview.view", "sending.view", "lists.view", "lists.manage", "contacts.view", "contacts.manage", "campaigns.view", "campaigns.manage", "campaigns.send", "deliveries.view", "suppressions.view", "suppressions.manage"] },
  { id: "analyst", label: "Analyst", description: "Read-only campaign reporting without recipient-level personal data.", permissions: ["overview.view", "sending.view", "lists.view", "campaigns.view"] },
];

const PERMISSION_DEFINITIONS = [
  ["overview.view", "Overview", "View operational totals and campaign reporting"],
  ["sending.view", "Sending setup", "View production-readiness status"],
  ["lists.view", "List reporting", "View list names and audience totals"],
  ["lists.manage", "Manage lists", "Create audience lists"],
  ["contacts.view", "Recipient data", "View contact identities and consent records"],
  ["contacts.manage", "Manage contacts", "Create and import contacts"],
  ["campaigns.view", "Campaign reporting", "View campaigns, content, and totals"],
  ["campaigns.manage", "Manage campaigns", "Create and edit campaign drafts"],
  ["campaigns.send", "Run campaigns", "Test and launch campaigns"],
  ["deliveries.view", "Delivery records", "View message records"],
  ["deliveries.feedback", "Delivery feedback", "Process delivery events"],
  ["suppressions.view", "Suppression data", "View suppressed addresses"],
  ["suppressions.manage", "Manage suppressions", "Add manual suppressions"],
  ["audit.view", "Audit log", "View administrative activity"],
  ["users.view", "User directory", "View users and roles"],
  ["users.manage", "Manage access", "Create and update users"],
].map(([id, label, description]) => ({ id, label, description }));

function permissionsForRole(role: string): string[] {
  return ROLE_DEFINITIONS.find((definition) => definition.id === role)?.permissions ?? [];
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function cookieHeader(token: string, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `sendstack_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function hasValidCsrf(request: Request, csrfToken: string): boolean {
  return request.headers.get("X-CSRF-Token") === csrfToken;
}

function renderTemplate(value: string, contact: { email: string; first_name?: string; last_name?: string }, unsubscribeUrl: string): string {
  return value
    .replaceAll("{{first_name}}", contact.first_name ?? "")
    .replaceAll("{{last_name}}", contact.last_name ?? "")
    .replaceAll("{{email}}", contact.email)
    .replaceAll("{{unsubscribe_url}}", unsubscribeUrl);
}

async function currentSession(request: Request) {
  const token = cookieValue(request, "sendstack_session");
  if (!token) return null;
  const result = await query<{
    token_hash: string; csrf_token: string; user_id: string; email: string; name: string;
    role: "admin" | "marketer" | "analyst"; must_change_password: boolean;
  }>(
    `SELECT s.token_hash, s.csrf_token, u.id AS user_id, u.email, u.name, u.role, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
    [tokenHash(token)],
  );
  const session = result.rows[0];
  return session ? { ...session, token } : null;
}

function sessionPayload(session: NonNullable<Awaited<ReturnType<typeof currentSession>>>) {
  return {
    csrf_token: session.csrf_token,
    permissions: permissionsForRole(session.role),
    delivery_mode: config.deliveryMode,
    must_change_password: session.must_change_password,
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
      role_label: session.role === "admin" ? "Administrator" : session.role === "marketer" ? "Marketer" : "Analyst",
      must_change_password: session.must_change_password,
    },
  };
}

async function requireSession(request: Request) {
  const session = await currentSession(request);
  return session ? { session } : { response: json(401, { error: "Not signed in." }) };
}

async function requireAdmin(request: Request) {
  const auth = await requireSession(request);
  if (auth.response) return auth;
  return auth.session.role === "admin"
    ? auth
    : { response: json(403, { error: "Administrator access is required." }) };
}

async function requirePermission(request: Request, permission: string) {
  const auth = await requireSession(request);
  if (auth.response) return auth;
  return permissionsForRole(auth.session.role).includes(permission)
    ? auth
    : { response: json(403, { error: "You do not have permission to access this resource." }) };
}

function userPayload(user: { id: string; email: string; name: string; role: string; active: boolean; must_change_password: boolean; created_at: string; last_login_at?: string | null }, currentUserId: string) {
  const role = ROLE_DEFINITIONS.find((definition) => definition.id === user.role) ?? ROLE_DEFINITIONS[2];
  return {
    ...user,
    role_label: role.label,
    is_current_user: user.id === currentUserId,
    last_login_at: user.last_login_at ?? null,
  };
}

function requestAuditContext(request: Request): Record<string, unknown> {
  return {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    user_agent: request.headers.get("user-agent") ?? "unknown",
  };
}

async function recordAudit(actorUserId: string | null, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [actorUserId, action, entityType, entityId, JSON.stringify(detail)],
  );
}

async function recordRequestAudit(request: Request, actorUserId: string | null, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  return recordAudit(actorUserId, action, entityType, entityId, { ...requestAuditContext(request), ...detail });
}

async function summaryResponse() {
  const counts = await query<{
    contacts: string;
    suppressed: string;
    queued: string;
    sent_today: string;
  }>(`SELECT
      (SELECT COUNT(*) FROM contacts WHERE status = 'active') AS contacts,
      (SELECT COUNT(*) FROM suppressions) AS suppressed,
      (SELECT COUNT(*) FROM campaign_recipients WHERE status IN ('queued', 'processing')) AS queued,
      (SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE) AS sent_today`);
  const recentCampaigns = await query(
    `SELECT c.id, c.name, c.subject, c.status,
            COUNT(cr.id)::int AS recipients,
            COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS sent,
            COUNT(cr.id) FILTER (WHERE cr.status IN ('failed', 'bounced', 'complained'))::int AS issues
       FROM campaigns c
       LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 8`,
  );
  const recentMessages = await query(
    `SELECT id, to_email, subject, status, created_at
       FROM messages ORDER BY created_at DESC LIMIT 8`,
  );
  const row = counts.rows[0];
  return json(200, {
    delivery_mode: config.deliveryMode,
    daily_limit: Number(process.env.SENDSTACK_DAILY_LIMIT ?? 50),
    counts: {
      contacts: Number(row?.contacts ?? 0),
      suppressed: Number(row?.suppressed ?? 0),
      queued: Number(row?.queued ?? 0),
      sent_today: Number(row?.sent_today ?? 0),
    },
    recent_campaigns: recentCampaigns.rows,
    recent_messages: recentMessages.rows,
  });
}

async function campaignById(id: string) {
  const result = await query<{
    id: string; name: string; subject: string; from_name: string; from_email: string;
    content_mode: string; content_json: string; html_body: string; text_body: string;
    list_id: string; list_name: string; status: string; created_at: string;
    launched_at: string | null; completed_at: string | null;
  }>(
    `SELECT c.*, l.name AS list_name FROM campaigns c JOIN lists l ON l.id = c.list_id WHERE c.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

function readinessResponse() {
  const resendConfigured = Boolean(
    process.env.RESEND_API_KEY &&
    process.env.RESEND_WEBHOOK_SECRET &&
    process.env.SENDSTACK_FROM_EMAIL,
  );
  const production = config.isVercelProduction || config.nodeEnv === "production";
  return json(200, {
    target: { platform: "Vercel", database: "Managed PostgreSQL", provider: "Resend Broadcasts" },
    current: { runtime: "Vercel", database: config.databaseUrl ? "PostgreSQL" : "Not configured", transport: config.deliveryMode },
    ready_for_live_sending: production && config.deliveryMode === "resend" && config.liveSendEnabled && resendConfigured,
    checks: [
      { id: "vercel_runtime", label: "Vercel runtime", status: production ? "ready" : "pending", detail: production ? "Running in a production Vercel environment." : "Deploy the production project on Vercel." },
      { id: "postgres_database", label: "PostgreSQL database", status: config.databaseUrl ? "ready" : "migration_required", detail: config.databaseUrl ? "Managed PostgreSQL is configured." : "Set DATABASE_URL and run migrations." },
      { id: "resend_broadcasts", label: "Resend delivery", status: resendConfigured && config.liveSendEnabled ? "ready" : resendConfigured ? "configured_locked" : "not_connected", detail: resendConfigured && config.liveSendEnabled ? "Resend API delivery is enabled for this production runtime." : resendConfigured ? "Resend credentials are configured; set SENDSTACK_LIVE_SEND_ENABLED=true." : "Set RESEND_API_KEY, RESEND_WEBHOOK_SECRET, and SENDSTACK_FROM_EMAIL." },
    ],
    delivery_path: ["Create a campaign draft", "Verify the audience and suppressions", "Submit through the configured delivery provider"],
    volume_plan: { goal: `${Number(process.env.SENDSTACK_DAILY_LIMIT ?? 50).toLocaleString()} emails/day`, launch_policy: "Increase volume only after delivery and complaint signals remain healthy." },
  });
}

export async function handleApi(request: Request, path: string[]) {
  const route = `/${path.join("/")}`;
  if (request.method === "POST" && route === "/auth/login") {
    const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
    const result = await query<{ id: string; email: string; name: string; role: "admin" | "marketer" | "analyst"; password_hash: string; must_change_password: boolean }>(
      `SELECT id, email, name, role, password_hash, must_change_password FROM users WHERE email = $1 AND active = TRUE`,
      [normalizeEmail(body.email ?? "")],
    );
    const user = result.rows[0];
    if (!user || !body.password || !verifyPassword(body.password, user.password_hash)) {
      await recordRequestAudit(request, user?.id ?? null, "login_failed", "authentication", user?.id ?? null, { email: normalizeEmail(body.email ?? "") });
      return json(401, { error: "Invalid email or password." });
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const hours = Number(process.env.SENDSTACK_SESSION_HOURS ?? 12);
    await query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'), NOW())`,
      [tokenHash(token), user.id, csrfToken, hours],
    );
    const response = json(200, sessionPayload({ ...user, user_id: user.id, token_hash: tokenHash(token), csrf_token: csrfToken, token } as never));
    response.headers.set("Set-Cookie", cookieHeader(token, hours * 3600));
    await recordRequestAudit(request, user.id, "login_succeeded", "session", tokenHash(token), { role: user.role });
    return response;
  }
  if (request.method === "GET" && route === "/session") {
    const session = await currentSession(request);
    return session ? json(200, sessionPayload(session)) : json(401, { error: "Not signed in." });
  }
  if (request.method === "GET" && route === "/summary") {
    const auth = await requirePermission(request, "overview.view");
    if (auth.response) return auth.response;
    return summaryResponse();
  }
  if (request.method === "GET" && route === "/production-readiness") {
    const auth = await requirePermission(request, "sending.view");
    if (auth.response) return auth.response;
    return readinessResponse();
  }
  if (request.method === "GET" && route === "/lists") {
    const auth = await requirePermission(request, "lists.view");
    if (auth.response) return auth.response;
    const lists = await query(
      `SELECT l.id, l.name, l.description, l.created_at, COUNT(lc.contact_id)::int AS contact_count
         FROM lists l LEFT JOIN list_contacts lc ON lc.list_id = l.id
        GROUP BY l.id ORDER BY l.name`,
    );
    return json(200, { lists: lists.rows });
  }
  if (request.method === "POST" && route === "/lists") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; description?: string };
    const name = (body.name ?? "").trim();
    const description = (body.description ?? "").trim();
    if (!name) return json(400, { error: "List name is required." });
    const existing = await query(`SELECT 1 FROM lists WHERE name = $1`, [name]);
    if (existing.rows[0]) return json(409, { error: "A list with that name already exists." });
    const id = `lst_${randomBytes(16).toString("hex")}`;
    await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1, $2, $3, NOW())`, [id, name, description]);
    await recordRequestAudit(request, auth.session.user_id, "list_created", "list", id, { name });
    return json(201, { list: { id, name, description, contact_count: 0 } });
  }
  const listMatch = route.match(/^\/lists\/([^/]+)$/);
  if (request.method === "PATCH" && listMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; description?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json(400, { error: "List name is required." });
    const updated = await query(
      `UPDATE lists SET name = $1, description = $2 WHERE id = $3 RETURNING id, name, description, created_at`,
      [name, (body.description ?? "").trim(), listMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "List not found." });
    await recordRequestAudit(request, auth.session.user_id, "list_updated", "list", listMatch[1], { name });
    return json(200, { list: updated.rows[0] });
  }
  if (request.method === "DELETE" && listMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM lists WHERE id = $1 RETURNING id`, [listMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "List not found." });
    await recordRequestAudit(request, auth.session.user_id, "list_deleted", "list", listMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/users") {
    const auth = await requirePermission(request, "users.view");
    if (auth.response) return auth.response;
    const users = await query<{
      id: string; email: string; name: string; role: string; active: boolean;
      must_change_password: boolean; created_at: string; last_login_at: string | null;
    }>(`SELECT u.id, u.email, u.name, u.role, u.active, u.must_change_password, u.created_at,
               MAX(a.created_at) FILTER (WHERE a.action = 'login_succeeded') AS last_login_at
          FROM users u
          LEFT JOIN audit_events a ON a.actor_user_id = u.id
         GROUP BY u.id
         ORDER BY u.created_at`);
    return json(200, {
      users: users.rows.map((user) => userPayload(user, auth.session.user_id)),
      roles: ROLE_DEFINITIONS,
      permissions: PERMISSION_DEFINITIONS,
    });
  }
  if (request.method === "GET" && route === "/suppressions") {
    const auth = await requirePermission(request, "suppressions.view");
    if (auth.response) return auth.response;
    const suppressions = await query(
      `SELECT email, reason, source, created_at FROM suppressions ORDER BY created_at DESC LIMIT 500`,
    );
    return json(200, { suppressions: suppressions.rows });
  }
  if (request.method === "GET" && route === "/audit") {
    const auth = await requirePermission(request, "audit.view");
    if (auth.response) return auth.response;
    const params = new URL(request.url).searchParams;
    const actionFilter = params.get("action")?.trim() ?? "";
    const entityFilter = params.get("entity_type")?.trim() ?? "";
    const limit = Math.min(Math.max(Number(params.get("limit") ?? 500) || 500, 1), 1000);
    const events = await query<{
      id: string; actor_user_id: string | null; actor_name: string | null; action: string;
      entity_type: string; entity_id: string | null; detail_json: string; created_at: string;
    }>(
      `SELECT a.id, a.actor_user_id, u.name AS actor_name, a.action, a.entity_type,
              a.entity_id, a.detail_json, a.created_at
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1 = '' OR a.action = $1) AND ($2 = '' OR a.entity_type = $2)
        ORDER BY a.created_at DESC LIMIT $3`,
      [actionFilter, entityFilter, limit],
    );
    return json(200, {
      events: events.rows.map((event) => ({
        ...event,
        detail: (() => { try { return JSON.parse(event.detail_json || "{}"); } catch { return {}; } })(),
      })),
    });
  }
  if (request.method === "POST" && route === "/suppressions") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { email?: string; reason?: string };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (body.reason !== "manual") return json(400, { error: "Manual suppressions must use the manual reason." });
    await applySuppression(email, "manual", "application");
    await recordRequestAudit(request, auth.session.user_id, "suppression_created", "suppression", email, { reason: "manual" });
    return json(201, { suppression: { email, reason: "manual", source: "application" } });
  }
  const suppressionMatch = route.match(/^\/suppressions\/([^/]+)$/);
  if (request.method === "DELETE" && suppressionMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const email = normalizeEmail(decodeURIComponent(suppressionMatch[1]));
    const deleted = await query(`DELETE FROM suppressions WHERE email = $1 RETURNING email`, [email]);
    if (!deleted.rows[0]) return json(404, { error: "Suppression not found." });
    await query(`UPDATE contacts SET status = 'active', updated_at = NOW() WHERE email = $1`, [email]);
    await recordRequestAudit(request, auth.session.user_id, "suppression_deleted", "suppression", email);
    return json(200, { ok: true });
  }
  if (request.method === "POST" && route === "/users") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; email?: string; role?: string; password?: string };
    const name = (body.name ?? "").trim();
    const email = normalizeEmail(body.email ?? "");
    const role = body.role ?? "marketer";
    if (!name || !validEmail(email)) return json(400, { error: "Enter a name and valid email address." });
    if (!ROLE_DEFINITIONS.some((definition) => definition.id === role)) return json(400, { error: "Select a valid role." });
    if (!body.password || body.password.length < 12) return json(400, { error: "Password must be at least 12 characters." });
    const existing = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (existing.rows[0]) return json(409, { error: "That email address already exists." });
    const id = `usr_${randomBytes(16).toString("hex")}`;
    await query(
      `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, NOW(), NOW())`,
      [id, email, name, role, hashPassword(body.password)],
    );
    await recordRequestAudit(request, auth.session.user_id, "user_created", "user", id, { email, role });
    return json(201, { user: userPayload({ id, email, name, role, active: true, must_change_password: true, created_at: new Date().toISOString() }, auth.session.user_id) });
  }
  const userMatch = route.match(/^\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    if (userMatch[1] === auth.session.user_id) return json(400, { error: "Another administrator must change your own access." });
    const body = await request.json().catch(() => ({})) as { name?: string; email?: string; role?: string; active?: boolean };
    const name = (body.name ?? "").trim();
    const email = normalizeEmail(body.email ?? "");
    if (!name || !validEmail(email)) return json(400, { error: "Enter a name and valid email address." });
    if (!ROLE_DEFINITIONS.some((definition) => definition.id === body.role)) return json(400, { error: "Select a valid role." });
    const updated = await query(
      `UPDATE users SET name = $1, email = $2, role = $3, active = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, email, name, role, active, must_change_password, created_at`,
      [name, email, body.role, body.active !== false, userMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "User not found." });
    await query(`DELETE FROM sessions WHERE user_id = $1`, [userMatch[1]]);
    await recordRequestAudit(request, auth.session.user_id, "user_access_updated", "user", userMatch[1], { email, role: body.role, active: body.active !== false });
    return json(200, { user: userPayload(updated.rows[0] as never, auth.session.user_id) });
  }
  if (request.method === "DELETE" && userMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    if (userMatch[1] === auth.session.user_id) return json(400, { error: "You cannot delete your own account." });
    const deleted = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "User not found." });
    await recordRequestAudit(request, auth.session.user_id, "user_deleted", "user", userMatch[1]);
    return json(200, { ok: true });
  }
  const resetMatch = route.match(/^\/users\/([^/]+)\/reset-password$/);
  if (request.method === "POST" && resetMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { password?: string };
    if (!body.password || body.password.length < 12) return json(400, { error: "Password must be at least 12 characters." });
    const updated = await query(`UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW() WHERE id = $2 RETURNING id`, [hashPassword(body.password), resetMatch[1]]);
    if (!updated.rows[0]) return json(404, { error: "User not found." });
    await query(`DELETE FROM sessions WHERE user_id = $1`, [resetMatch[1]]);
    await recordRequestAudit(request, auth.session.user_id, "user_password_reset", "user", resetMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/contacts") {
    const auth = await requirePermission(request, "contacts.view");
    if (auth.response) return auth.response;
    const search = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const contacts = await query(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.consent_source,
              c.created_at, STRING_AGG(l.name, ', ' ORDER BY l.name) AS lists
         FROM contacts c
         LEFT JOIN list_contacts lc ON lc.contact_id = c.id
         LEFT JOIN lists l ON l.id = lc.list_id
        WHERE ($1 = '' OR c.email ILIKE '%' || $1 || '%' OR c.first_name ILIKE '%' || $1 || '%' OR c.last_name ILIKE '%' || $1 || '%')
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 500`,
      [search],
    );
    return json(200, { contacts: contacts.rows });
  }
  const contactMatch = route.match(/^\/contacts\/([^/]+)$/);
  if (request.method === "PATCH" && contactMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { email?: string; first_name?: string; last_name?: string; status?: string; consent_source?: string };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (!body.status || !["active", "suppressed"].includes(body.status)) return json(400, { error: "Select a valid contact status." });
    const updated = await query(
      `UPDATE contacts SET email = $1, first_name = $2, last_name = $3, status = $4, consent_source = $5, updated_at = NOW()
       WHERE id = $6 RETURNING id, email, first_name, last_name, status, consent_source, created_at`,
      [email, (body.first_name ?? "").trim(), (body.last_name ?? "").trim(), body.status, (body.consent_source ?? "manual").trim(), contactMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "Contact not found." });
    await recordRequestAudit(request, auth.session.user_id, "contact_updated", "contact", contactMatch[1], { email, status: body.status });
    return json(200, { contact: updated.rows[0] });
  }
  if (request.method === "DELETE" && contactMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [contactMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "Contact not found." });
    await recordRequestAudit(request, auth.session.user_id, "contact_deleted", "contact", contactMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/campaigns") {
    const auth = await requirePermission(request, "campaigns.view");
    if (auth.response) return auth.response;
    const campaigns = await query(
      `SELECT c.id, c.name, c.subject, c.from_name, c.from_email, c.content_mode,
              c.status, c.created_at, l.name AS list_name,
              COUNT(cr.id)::int AS recipients,
              COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS sent,
              COUNT(cr.id) FILTER (WHERE cr.status = 'queued')::int AS queued,
              COUNT(cr.id) FILTER (WHERE cr.status = 'failed')::int AS failed,
              COUNT(cr.id) FILTER (WHERE cr.status = 'bounced')::int AS bounced,
              COUNT(cr.id) FILTER (WHERE cr.status = 'complained')::int AS complained
         FROM campaigns c JOIN lists l ON l.id = c.list_id
         LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
        GROUP BY c.id, l.name ORDER BY c.created_at DESC`,
    );
    return json(200, { campaigns: campaigns.rows });
  }
  if (request.method === "POST" && route === "/campaigns") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      name?: string;
      list_id?: string;
      from_name?: string;
      from_email?: string;
      subject?: string;
      content_mode?: string;
      content_json?: unknown;
      html_body?: string;
      text_body?: string;
    };
    const name = (body.name ?? "").trim();
    const listId = body.list_id ?? "";
    const fromName = (body.from_name ?? "").trim();
    const fromEmail = normalizeEmail(body.from_email ?? "");
    const subject = (body.subject ?? "").trim();
    const contentMode = body.content_mode ?? "custom_html";
    const validModes = ["visual", "rich_text", "custom_html", "plain_text"];
    if (!name || !fromName || !subject) return json(400, { error: "Name, sender, and subject are required." });
    if (!validEmail(fromEmail)) return json(400, { error: "Enter a valid sender email address." });
    if (!listId) return json(400, { error: "Select an audience list." });
    if (!validModes.includes(contentMode)) return json(400, { error: "Select a valid message format." });
    const list = await query(`SELECT id FROM lists WHERE id = $1`, [listId]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });

    let contentJson = "{\"schema_version\":1}";
    if (body.content_json) {
      try {
        const parsedContent = typeof body.content_json === "string"
          ? JSON.parse(body.content_json)
          : body.content_json;
        contentJson = JSON.stringify(parsedContent);
      } catch {
        return json(400, { error: "Campaign content is invalid." });
      }
    }
    const id = `cam_${randomBytes(16).toString("hex")}`;
    await query(
      `INSERT INTO campaigns
         (id, name, subject, from_name, from_email, content_mode, content_json, html_body, text_body,
          list_id, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, NOW(), NOW())`,
      [id, name, subject, fromName, fromEmail, contentMode, contentJson, body.html_body ?? "", body.text_body ?? "", listId, auth.session.user_id],
    );
    await recordRequestAudit(request, auth.session.user_id, "campaign_created", "campaign", id, { name, list_id: listId, content_mode: contentMode });
    return json(201, { campaign: { id, name, subject, status: "draft", list_id: listId } });
  }
  const campaignMatch = route.match(/^\/campaigns\/([^/]+)$/);
  if (request.method === "GET" && campaignMatch) {
    const auth = await requirePermission(request, "campaigns.view");
    if (auth.response) return auth.response;
    const campaign = await campaignById(campaignMatch[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    const stats = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
      [campaign.id],
    );
    return json(200, { campaign: { ...campaign, stats: Object.fromEntries(stats.rows.map((row) => [row.status, row.count])) } });
  }
  if (request.method === "PATCH" && campaignMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; subject?: string; from_name?: string; from_email?: string; list_id?: string; content_mode?: string; content_json?: unknown; html_body?: string; text_body?: string };
    const name = (body.name ?? "").trim();
    const fromEmail = normalizeEmail(body.from_email ?? "");
    if (!name || !(body.subject ?? "").trim() || !(body.from_name ?? "").trim()) return json(400, { error: "Name, sender, and subject are required." });
    if (!validEmail(fromEmail)) return json(400, { error: "Enter a valid sender email address." });
    const contentJson = typeof body.content_json === "string" ? body.content_json : JSON.stringify(body.content_json ?? { schema_version: 1 });
    try { JSON.parse(contentJson); } catch { return json(400, { error: "Campaign content is invalid." }); }
    const updated = await query(
      `UPDATE campaigns SET name = $1, subject = $2, from_name = $3, from_email = $4, list_id = $5,
       content_mode = $6, content_json = $7, html_body = $8, text_body = $9, updated_at = NOW()
       WHERE id = $10 AND status IN ('draft', 'paused') RETURNING id, name, subject, status, list_id`,
      [name, (body.subject ?? "").trim(), (body.from_name ?? "").trim(), fromEmail, body.list_id, body.content_mode ?? "custom_html", contentJson, body.html_body ?? "", body.text_body ?? "", campaignMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "Editable campaign not found." });
    await recordRequestAudit(request, auth.session.user_id, "campaign_updated", "campaign", campaignMatch[1], { name, list_id: body.list_id });
    return json(200, { campaign: updated.rows[0] });
  }
  if (request.method === "DELETE" && campaignMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM campaigns WHERE id = $1 AND status = 'draft' RETURNING id`, [campaignMatch[1]]);
    if (!deleted.rows[0]) return json(409, { error: "Only draft campaigns can be deleted." });
    await recordRequestAudit(request, auth.session.user_id, "campaign_deleted", "campaign", campaignMatch[1]);
    return json(200, { ok: true });
  }
  const campaignAction = route.match(/^\/campaigns\/([^/]+)\/(test-send|launch|pause|resume)$/);
  if (request.method === "POST" && campaignAction) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const campaign = await campaignById(campaignAction[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    const body = await request.json().catch(() => ({})) as { email?: string };
    const targetEmail = normalizeEmail(body.email ?? "");
    const contacts = campaignAction[2] === "test-send"
      ? [{ id: null, email: targetEmail, first_name: "Test", last_name: "Recipient" }]
      : (await query<{ id: string; email: string; first_name: string; last_name: string }>(
          `SELECT c.id, c.email, c.first_name, c.last_name
             FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id
            WHERE lc.list_id = $1 AND c.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
          [campaign.list_id],
        )).rows;
    if (campaignAction[2] === "test-send" && !validEmail(targetEmail)) return json(400, { error: "Enter a valid test recipient email." });
    if (campaignAction[2] === "launch" && campaign.status !== "draft" && campaign.status !== "paused") return json(400, { error: "Only draft or paused campaigns can be launched." });
    if (campaignAction[2] === "pause" || campaignAction[2] === "resume") {
      const status = campaignAction[2] === "pause" ? "paused" : "sending";
      await query(`UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2`, [status, campaign.id]);
      await recordRequestAudit(request, auth.session.user_id, `campaign_${campaignAction[2]}d`, "campaign", campaign.id, { status });
      return json(200, { ok: true, status });
    }
    for (const contact of contacts) {
      const recipientId = `rec_${randomBytes(16).toString("hex")}`;
      const messageId = `msg_${randomBytes(16).toString("hex")}`;
      const unsubscribeToken = randomBytes(24).toString("base64url");
      const unsubscribeUrl = `${process.env.SENDSTACK_PUBLIC_URL ?? "http://localhost:3000"}/u/${unsubscribeToken}`;
      const htmlBody = renderTemplate(campaign.html_body, contact, unsubscribeUrl);
      const textBody = renderTemplate(campaign.text_body, contact, unsubscribeUrl);
      const subject = renderTemplate(campaign.subject, contact, unsubscribeUrl);
      const providerEmail = config.deliveryMode === "resend"
        ? await sendResendEmail({
            to: contact.email,
        subject,
            html: htmlBody,
            text: textBody,
            fromName: campaign.from_name,
            fromEmail: campaign.from_email,
            unsubscribeUrl,
          })
        : null;
      if (contact.id) {
        await query(
          `INSERT INTO campaign_recipients (id, campaign_id, contact_id, email, status, message_id, provider_email_id, queued_at, sent_at)
           VALUES ($1, $2, $3, $4, 'sent', $5, $6, NOW(), NOW()) ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [recipientId, campaign.id, contact.id, contact.email, messageId, providerEmail?.id ?? null],
        );
      }
      await query(
        `INSERT INTO messages (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email, html_body, text_body, status, unsubscribe_token, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'captured', $10, NOW())`,
        [messageId, campaign.id, contact.id ? recipientId : null, contact.id, contact.email, subject, campaign.from_email, htmlBody, textBody, unsubscribeToken],
      );
      if (providerEmail) {
        await query(`UPDATE messages SET status = 'submitted', provider_id = $1 WHERE id = $2`, [providerEmail.id, messageId]);
      }
    }
    await query(`UPDATE campaigns SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [campaign.id]);
    await recordRequestAudit(request, auth.session.user_id, campaignAction[2] === "test-send" ? "campaign_test_sent" : "campaign_launched", "campaign", campaign.id, { recipients: contacts.length, delivery_mode: config.deliveryMode });
    return json(200, { queued: contacts.length, sent: contacts.length });
  }
  if (request.method === "GET" && route === "/messages") {
    const auth = await requirePermission(request, "deliveries.view");
    if (auth.response) return auth.response;
    const messages = await query(
      `SELECT m.id, m.to_email, m.subject, m.from_email, m.status, m.created_at, m.unsubscribe_token, c.name AS campaign_name
         FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id ORDER BY m.created_at DESC LIMIT 500`,
    );
    return json(200, { messages: messages.rows });
  }
  const messageMatch = route.match(/^\/messages\/([^/]+)$/);
  if (request.method === "GET" && messageMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    const message = await query(`SELECT m.*, c.name AS campaign_name FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = $1`, [messageMatch[1]]);
    if (!message.rows[0]) return json(404, { error: "Message not found." });
    return json(200, { message: message.rows[0] });
  }
  if (request.method === "DELETE" && messageMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM messages WHERE id = $1 RETURNING id`, [messageMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "Message not found." });
    await recordRequestAudit(request, auth.session.user_id, "message_deleted", "message", messageMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "POST" && route === "/contacts") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      email?: string;
      first_name?: string;
      last_name?: string;
      consent_source?: string;
      list_id?: string;
    };
    const email = normalizeEmail(body.email ?? "");
    const firstName = (body.first_name ?? "").trim();
    const lastName = (body.last_name ?? "").trim();
    const consentSource = (body.consent_source ?? "").trim();
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (!consentSource) return json(400, { error: "Consent source is required." });
    if (!body.list_id) return json(400, { error: "Select a destination list." });

    const list = await query(`SELECT id FROM lists WHERE id = $1`, [body.list_id]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });
    const existing = await query(`SELECT id FROM contacts WHERE email = $1`, [email]);
    if (existing.rows[0]) return json(409, { error: "That email address already exists." });

    const id = `con_${randomBytes(16).toString("hex")}`;
    const suppressed = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
    await query(
      `INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())`,
      [id, email, firstName, lastName, suppressed.rows[0] ? "suppressed" : "active", consentSource],
    );
    await query(
      `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
      [body.list_id, id],
    );
    await recordRequestAudit(request, auth.session.user_id, "contact_created", "contact", id, { email, list_id: body.list_id, consent_source: consentSource });
    return json(201, { contact: { id, email, first_name: firstName, last_name: lastName } });
  }
  if (request.method === "POST" && route === "/auth/change-password") {
    const session = await currentSession(request);
    if (!session) return json(401, { error: "Not signed in." });
    if (!hasValidCsrf(request, session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      current_password?: string;
      new_password?: string;
    };
    if (!body.current_password || !verifyPassword(body.current_password, (await query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [session.user_id],
    )).rows[0]?.password_hash ?? "")) {
      return json(400, { error: "Current password is incorrect." });
    }
    if (!body.new_password || body.new_password.length < 12) {
      return json(400, { error: "New password must be at least 12 characters." });
    }
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [hashPassword(body.new_password), session.user_id],
    );
    await recordRequestAudit(request, session.user_id, "password_changed", "user", session.user_id);
    return json(200, sessionPayload({ ...session, must_change_password: false }));
  }
  if (request.method === "POST" && route === "/auth/logout") {
    const token = cookieValue(request, "sendstack_session");
    const session = await currentSession(request);
    if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
    if (session) await recordRequestAudit(request, session.user_id, "logout", "session", token ? tokenHash(token) : null);
    const response = json(200, { ok: true });
    response.headers.set("Set-Cookie", cookieHeader("", 0));
    return response;
  }
  return json(404, { error: "API route not implemented." });
}
