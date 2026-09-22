import { createHmac, timingSafeEqual } from "crypto";
import { applySuppression } from "@/lib/suppressions";
import { query } from "@/lib/db";

function verifySignature(body: string, request: Request): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const messageId = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatureHeader = request.headers.get("svix-signature");
  if (!secret || !messageId || !timestamp || !signatureHeader) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(encodedSecret, "base64");
  const expected = createHmac("sha256", key).update(`${messageId}.${timestamp}.${body}`).digest("base64");
  return signatureHeader.split(" ").some((entry) => {
    const value = entry.replace(/^v1,/, "");
    const actualBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!verifySignature(body, request)) return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  const event = JSON.parse(body) as {
    type?: string;
    data?: { email_id?: string; to?: string[] | string; created_at?: string };
  };
  const providerId = event.data?.email_id;
  const recipients = Array.isArray(event.data?.to) ? event.data.to : event.data?.to ? [event.data.to] : [];
  const eventId = request.headers.get("svix-id") ?? `resend_${Date.now()}`;
  await query(
    `INSERT INTO provider_events (id, provider, event_type, payload_json, created_at, processed_at)
     VALUES ($1, 'resend', $2, $3, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    [eventId, event.type ?? "unknown", body],
  );

  if (providerId && event.type === "email.delivered") {
    await query(`UPDATE messages SET status = 'delivered', provider_id = $1, delivered_at = NOW() WHERE provider_id = $1`, [providerId]);
  }
  if (event.type === "email.bounced" || event.type === "email.complained") {
    const reason = event.type === "email.bounced" ? "hard_bounce" : "complaint";
    for (const email of recipients) await applySuppression(email, reason, "resend_webhook");
    if (providerId) {
      await query(`UPDATE messages SET status = $1, provider_id = $2 WHERE provider_id = $2`, [reason === "complaint" ? "complained" : "bounced", providerId]);
    }
  }
  return Response.json({ received: true });
}
