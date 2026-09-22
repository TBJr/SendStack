import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { requireCsrf, passwordChangeAllowedPath, type SessionUser } from "../lib/auth";
import { hashPassword, verifyPassword, normalizeEmail, validEmail, makeId } from "../lib/ids";
import { permissionsForRole, requiredPermission, ROLE_DEFINITIONS } from "../lib/rbac";
import { validateEmailContent, renderTemplate } from "../lib/templates";
import {
  verifySvixSignature,
  isTimestampFresh,
  shouldReuseExistingBroadcast,
} from "../lib/providers/webhook";
import { liveSendAllowed } from "../lib/providers/resend";
import { validateProductionEnv } from "../lib/env";

const sampleSession: SessionUser = {
  tokenHash: "abc",
  csrfToken: "csrf-token-value",
  expiresAt: new Date().toISOString(),
  userId: "usr_1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  mustChangePassword: false,
};

describe("password hashing", () => {
  it("round-trips pbkdf2 hashes compatible with the Python format", () => {
    const encoded = hashPassword("ChangeMe123!");
    expect(encoded.startsWith("pbkdf2_sha256$210000$")).toBe(true);
    expect(verifyPassword("ChangeMe123!", encoded)).toBe(true);
    expect(verifyPassword("wrong", encoded)).toBe(false);
  });
});

describe("rbac", () => {
  it("gives admin every permission", () => {
    expect(permissionsForRole("admin").has("users.manage")).toBe(true);
    expect(permissionsForRole("analyst").has("contacts.view")).toBe(false);
    expect(permissionsForRole("admin").size).toBe(ROLE_DEFINITIONS.admin.permissions.length);
  });

  it("maps routes to permissions", () => {
    expect(requiredPermission("POST", "/api/campaigns/cam_1/launch")).toBe("campaigns.send");
    expect(requiredPermission("GET", "/api/campaigns/cam_1")).toBe("campaigns.view");
    expect(requiredPermission("POST", "/api/auth/login")).toBeNull();
  });
});

describe("csrf", () => {
  it("rejects missing or mismatched CSRF tokens", () => {
    const bad = new Request("http://localhost/api/lists", {
      method: "POST",
      headers: { "X-CSRF-Token": "wrong" },
    });
    expect(requireCsrf(bad, sampleSession)).toMatch(/CSRF/);
    const good = new Request("http://localhost/api/lists", {
      method: "POST",
      headers: { "X-CSRF-Token": "csrf-token-value" },
    });
    expect(requireCsrf(good, sampleSession)).toBeNull();
  });

  it("allows only password-change escape routes while must_change_password is set", () => {
    expect(passwordChangeAllowedPath("/api/auth/change-password", "POST")).toBe(true);
    expect(passwordChangeAllowedPath("/api/auth/logout", "POST")).toBe(true);
    expect(passwordChangeAllowedPath("/api/session", "GET")).toBe(true);
    expect(passwordChangeAllowedPath("/api/campaigns", "POST")).toBe(false);
  });
});

describe("email helpers", () => {
  it("normalizes and validates emails", () => {
    expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
    expect(validEmail("a@b.com")).toBe(true);
    expect(validEmail("nope")).toBe(false);
  });

  it("requires unsubscribe merge fields and rejects unsafe HTML", () => {
    expect(() => validateEmailContent("<p>Hi {{first_name}}</p>", "Hi {{first_name}}")).toThrow(
      /unsubscribe/,
    );
    expect(() =>
      validateEmailContent(
        '<p><a href="{{unsubscribe_url}}">unsub</a><script>x</script></p>',
        "unsub {{unsubscribe_url}}",
      ),
    ).toThrow(/unsafe/);
    expect(() =>
      validateEmailContent(
        '<p><a href="{{unsubscribe_url}}">unsub</a></p>',
        "unsub {{unsubscribe_url}}",
      ),
    ).not.toThrow();
  });

  it("renders merge fields", () => {
    expect(renderTemplate("Hello {{first_name}}", { first_name: "Pat" })).toBe("Hello Pat");
  });
});

describe("ids", () => {
  it("prefixes generated ids", () => {
    expect(makeId("cam").startsWith("cam_")).toBe(true);
  });
});

describe("live send kill switch", () => {
  it("stays locked without credentials and flag", () => {
    expect(liveSendAllowed()).toBe(false);
  });
});

describe("launch idempotency helper", () => {
  it("reuses an existing provider broadcast id", () => {
    expect(shouldReuseExistingBroadcast(null)).toBe(false);
    expect(shouldReuseExistingBroadcast("bcast_123")).toBe(true);
  });
});

describe("webhook signature and replay guards", () => {
  it("accepts a matching svix-style hmac and rejects tampering", () => {
    const secret = "whsec_" + Buffer.from("test-secret").toString("base64");
    const key = Buffer.from(secret.slice(6), "base64");
    const id = "msg_123";
    const timestamp = "1710000000";
    const body = '{"type":"email.delivered"}';
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    expect(verifySvixSignature(secret, body, id, timestamp, `v1,${expected}`)).toBe(true);
    expect(verifySvixSignature(secret, body, id, timestamp, `v1,${expected}tampered`)).toBe(false);
    expect(verifySvixSignature(secret, '{"type":"other"}', id, timestamp, `v1,${expected}`)).toBe(false);
  });

  it("rejects stale timestamps and accepts fresh ones", () => {
    const now = 1_700_000_000;
    expect(isTimestampFresh(String(now), 300, now)).toBe(true);
    expect(isTimestampFresh(String(now - 301), 300, now)).toBe(false);
    expect(isTimestampFresh("not-a-number", 300, now)).toBe(false);
  });
});

describe("production env validation", () => {
  it("is a no-op outside production-like environments", () => {
    expect(() => validateProductionEnv()).not.toThrow();
  });
});
