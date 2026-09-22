import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const vercelEnv = process.env.VERCEL_ENV ?? "";
const liveSendEnabled = booleanEnv("SENDSTACK_LIVE_SEND_ENABLED", false);
const deliveryMode =
  process.env.SENDSTACK_DELIVERY_MODE?.trim().toLowerCase() ||
  (liveSendEnabled && process.env.RESEND_API_KEY ? "resend" : "sandbox");

export const config = {
  nodeEnv,
  isVercelProduction: vercelEnv === "production",
  isVercelPreview: vercelEnv === "preview",
  databaseUrl: process.env.DATABASE_URL ?? "",
  deliveryMode,
  liveSendEnabled,
  adminEmail: process.env.SENDSTACK_ADMIN_EMAIL ?? "admin@sendstack.local",
  adminPassword: process.env.SENDSTACK_ADMIN_PASSWORD ?? "ChangeMe123!",
  defaultAdminPassword: "ChangeMe123!",
  cookieSecure: booleanEnv("SENDSTACK_COOKIE_SECURE", false),
};
