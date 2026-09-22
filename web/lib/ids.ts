import { timingSafeEqual, pbkdf2Sync, randomBytes, randomUUID } from "crypto";

const PASSWORD_ITERATIONS = 210_000;

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return [
    "pbkdf2_sha256",
    PASSWORD_ITERATIONS,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, iterationsText, saltText, digestText] = encoded.split("$", 4);
    if (algorithm !== "pbkdf2_sha256" || !iterationsText || !saltText || !digestText) return false;
    const expected = Buffer.from(digestText, "base64url");
    const candidate = pbkdf2Sync(
      password,
      Buffer.from(saltText, "base64url"),
      Number(iterationsText),
      expected.length,
      "sha256",
    );
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function utcNow(): string {
  return new Date().toISOString();
}
