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
