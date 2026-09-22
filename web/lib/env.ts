const productionLike =
  process.env.VERCEL_ENV === "production" ||
  (process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview");

export function validateProductionEnv(): void {
  if (!productionLike) {
    return;
  }

  const missing = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["SENDSTACK_SESSION_SECRET", process.env.SENDSTACK_SESSION_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
}
