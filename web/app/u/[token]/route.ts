import { query } from "@/lib/db";
import { applySuppression } from "@/lib/suppressions";

const PAGE_CSS = `html{font-family:ui-sans-serif,system-ui,sans-serif;background:#07111f;color:#eaf1ff;color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:520px;background:#101d31;border:1px solid #263854;border-radius:20px;padding:36px;box-shadow:0 24px 70px #0008}.mark{width:44px;height:44px;border-radius:14px;background:#5b7cff;display:grid;place-items:center;font-weight:800}h1{font-size:28px;margin:22px 0 10px}p{color:#adc0dc;line-height:1.6}strong{color:#fff}button{border:0;border-radius:10px;padding:12px 18px;background:#5b7cff;color:#fff;font:inherit;font-weight:700;cursor:pointer}.small{font-size:13px}`;

function page(title: string, message: string, form?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body><main><div class="mark">S</div><h1>${escapeHtml(title)}</h1><p>${message}</p>${form ?? ""}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Params = { params: Promise<{ token: string }> };

export async function GET(_request: Request, context: Params) {
  const { token } = await context.params;
  const result = await query<{ to_email: string }>(
    `SELECT to_email FROM messages WHERE unsubscribe_token = $1`,
    [token],
  );
  if (!result.rows[0]) {
    return new Response(page("Link expired", "This unsubscribe link is invalid or has already been used."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const form = `<form method="post"><button type="submit">Unsubscribe ${escapeHtml(result.rows[0].to_email)}</button></form><p class="small">You will be removed from future SendStack campaigns.</p>`;
  return new Response(
    page("Unsubscribe", `Confirm unsubscribe for <strong>${escapeHtml(result.rows[0].to_email)}</strong>.`, form),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function POST(_request: Request, context: Params) {
  const { token } = await context.params;
  const result = await query<{ to_email: string }>(
    `SELECT to_email FROM messages WHERE unsubscribe_token = $1`,
    [token],
  );
  if (!result.rows[0]) {
    return new Response(page("Link expired", "This unsubscribe link is invalid or has already been used."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  await applySuppression(result.rows[0].to_email, "unsubscribe", "one_click");
  await query(
    `UPDATE messages SET status = 'unsubscribed' WHERE unsubscribe_token = $1 AND status NOT IN ('bounced', 'complained')`,
    [token],
  );
  return new Response(
    page("Unsubscribed", `You have been unsubscribed. Future campaigns will not include this address.`),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
