import { pbkdf2Sync, randomBytes, randomUUID } from "crypto";

const PASSWORD_ITERATIONS = 210_000;

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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

export function utcNow(): string {
  return new Date().toISOString();
}
