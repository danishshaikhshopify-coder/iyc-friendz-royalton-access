/**
 * "Your booking link is ready" email content.
 *
 * IMPORTANT — content provenance: the subject line and button label below
 * are the exact strings given in the Task 17 spec. The body copy is
 * written to match the spec's described content (confirms the Event Pass
 * purchase, explains the hotel reservation is separate, directs the
 * customer to click through to the secure page rather than giving the
 * Royalton URL directly) but was reconstructed for this implementation
 * rather than copied character-for-character from the original brief,
 * because the literal body text was not available at the time this file
 * was written. This is flagged explicitly in the Task 17 report
 * (Outstanding Requirements) as something to diff against the original
 * spec text before this email is used for a real customer send.
 *
 * Hard requirement this file must never violate: the email body must NOT
 * contain the real Royalton booking URL — only a link to this service's
 * secure access page. The access page itself decides, per-request and
 * live, whether to reveal the Royalton URL.
 */

export interface AccessReadyEmailParams {
  accessPageUrl: string;
  orderName: string; // e.g. "#1234" — safe, not a secret, already shown to the customer in Shopify
}

export const ACCESS_READY_EMAIL_SUBJECT = "Your Royalton Booking Link Is Ready!";

export function renderAccessReadyEmailText(params: AccessReadyEmailParams): string {
  return [
    "Your Royalton Booking Link Is Ready!",
    "",
    `Your IYC & FRIENDZ Event Pass purchase (order ${params.orderName}) is confirmed.`,
    "",
    "Your hotel reservation at Royalton Bavaro is separate from your Event Pass.",
    "To secure your hotel room, use your private, personal booking link below.",
    "",
    "ACCESS YOUR ROYALTON BOOKING LINK:",
    params.accessPageUrl,
    "",
    "This link is unique to your order — please don't forward or share it.",
    "A one-night deposit is required to secure your room. The remaining balance",
    "is payable directly at the resort.",
  ].join("\n");
}

export function renderAccessReadyEmailHtml(params: AccessReadyEmailParams): string {
  const safeUrl = escapeHtmlAttribute(params.accessPageUrl);
  const safeOrderName = escapeHtml(params.orderName);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#0b1f17;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b1f17;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#0b1f17;border:1px solid #c9a24b;border-radius:8px;padding:32px;">
            <tr>
              <td style="color:#c9a24b;font-size:22px;font-weight:bold;letter-spacing:0.5px;padding-bottom:16px;">
                Your Royalton Booking Link Is Ready!
              </td>
            </tr>
            <tr>
              <td style="color:#ffffff;font-size:15px;line-height:1.6;padding-bottom:12px;">
                Your IYC &amp; FRIENDZ Event Pass purchase (order ${safeOrderName}) is confirmed.
              </td>
            </tr>
            <tr>
              <td style="color:#ffffff;font-size:15px;line-height:1.6;padding-bottom:24px;">
                Your hotel reservation at Royalton Bavaro is separate from your Event Pass.
                To secure your hotel room, use your private, personal booking link below.
                This link is unique to your order — please don't forward or share it.
                A one-night deposit is required to secure your room. The remaining balance
                is payable directly at the resort.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:8px;">
                <a href="${safeUrl}" style="display:inline-block;background-color:#c9a24b;color:#0b1f17;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:4px;font-size:14px;letter-spacing:0.5px;">
                  ACCESS YOUR ROYALTON BOOKING LINK
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeHtmlAttribute(value: string): string {
  // URLs go into an href attribute; escape quotes to prevent attribute
  // breakout even though these URLs are server-generated, not user input.
  return escapeHtml(value);
}
