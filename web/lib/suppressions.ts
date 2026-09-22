import { query } from "./db";
import { normalizeEmail } from "./ids";

type SuppressionReason = "unsubscribe" | "hard_bounce" | "complaint" | "manual";

export async function applySuppression(
  email: string,
  reason: SuppressionReason,
  source = "application",
): Promise<void> {
  await query(
    `INSERT INTO suppressions (email, reason, source, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source`,
    [normalizeEmail(email), reason, source],
  );
  await query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [
    normalizeEmail(email),
  ]);
}
