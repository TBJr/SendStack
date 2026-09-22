import { createHash, randomBytes } from "crypto";
import { json } from "./http";
import { config } from "./config";
import { query } from "./db";
import { hashPassword, normalizeEmail, verifyPassword } from "./ids";

const ADMIN_PERMISSIONS = [
  "overview.view", "sending.view", "lists.view", "lists.manage", "contacts.view",
  "contacts.manage", "campaigns.view", "campaigns.manage", "campaigns.send", "deliveries.view",
  "deliveries.feedback", "suppressions.view", "suppressions.manage", "audit.view", "users.view", "users.manage",
];

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
    permissions: session.role === "admin" ? ADMIN_PERMISSIONS : [],
    delivery_mode: "sandbox",
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
    return response;
  }
  if (request.method === "GET" && route === "/session") {
    const session = await currentSession(request);
    return session ? json(200, sessionPayload(session)) : json(401, { error: "Not signed in." });
  }
  if (request.method === "GET" && route === "/summary") {
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    return summaryResponse();
  }
  if (request.method === "GET" && route === "/lists") {
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    const lists = await query(
      `SELECT l.id, l.name, l.description, l.created_at, COUNT(lc.contact_id)::int AS contact_count
         FROM lists l LEFT JOIN list_contacts lc ON lc.list_id = l.id
        GROUP BY l.id ORDER BY l.name`,
    );
    return json(200, { lists: lists.rows });
  }
  if (request.method === "GET" && route === "/contacts") {
    const auth = await requireSession(request);
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
    return json(200, sessionPayload({ ...session, must_change_password: false }));
  }
  if (request.method === "POST" && route === "/auth/logout") {
    const token = cookieValue(request, "sendstack_session");
    if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
    const response = json(200, { ok: true });
    response.headers.set("Set-Cookie", cookieHeader("", 0));
    return response;
  }
  return json(404, { error: "API route not implemented." });
}
