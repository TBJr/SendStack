import { config } from "../config";

export type ResendAttachment = {
  filename: string;
  contentBase64: string;
  contentType: string;
};

export type ResendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  fromEmail: string;
  unsubscribeUrl?: string;
  attachments?: ResendAttachment[];
};

export async function sendResendEmail(input: ResendEmailInput): Promise<{ id: string }> {
  if (!config.liveSendEnabled || !process.env.RESEND_API_KEY) {
    throw new Error("Resend live sending is not enabled.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${input.fromName} <${input.fromEmail}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
      attachments: input.attachments?.length
        ? input.attachments.map((file) => ({
            filename: file.filename,
            content: file.contentBase64,
            content_type: file.contentType,
          }))
        : undefined,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!response.ok || !payload.id) {
    throw new Error(payload.message || payload.name || `Resend request failed (${response.status}).`);
  }
  return { id: payload.id };
}
