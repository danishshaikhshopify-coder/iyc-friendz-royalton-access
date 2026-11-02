/**
 * Email delivery abstraction.
 *
 * Why an abstraction at all: this service must send one transactional,
 * per-customer email containing a unique access link. Dani's existing
 * marketing tools for this client (Klaviyo / Omnisend / Postscript, per
 * prior project notes) are built around marketing flows/automations
 * triggered by events, not around "send this exact, code-controlled HTML
 * to this one address right now" — which is what a security-sensitive,
 * per-customer link needs. Without live credentials to test against, this
 * service does NOT assume Klaviyo/Omnisend can reliably do this; see the
 * KlaviyoEmailSender/OmnisendEmailSender comments below and the Task 17
 * report's Outstanding Requirements section.
 *
 * EmailSender is the interface every provider implements. The webhook
 * handler calls `getEmailSender().send(...)`, never a provider directly,
 * so swapping providers is a one-line config change.
 */

import { config } from "@/lib/config";
import {
  ACCESS_READY_EMAIL_SUBJECT,
  renderAccessReadyEmailHtml,
  renderAccessReadyEmailText,
  type AccessReadyEmailParams,
} from "@/lib/email-templates/access-ready";

export interface EmailSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailSender {
  sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult>;
}

/**
 * Dev/test provider. Does not send anything over the network — logs the
 * rendered email to the console. This is the default (EMAIL_PROVIDER=none)
 * so the service runs end-to-end locally with no email credentials.
 */
class NoneEmailSender implements EmailSender {
  async sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult> {
    // eslint-disable-next-line no-console
    console.log("[email:none] Would send access-ready email", {
      to,
      subject: ACCESS_READY_EMAIL_SUBJECT,
      orderName: params.orderName,
      // Never log the raw access URL containing the token in production
      // logs; for the local "none" provider this is acceptable since
      // nothing here is a real customer or a real token, but we still
      // redact to keep the dev/prod code paths identical in behavior.
      accessPageUrl: redactUrlToken(params.accessPageUrl),
    });
    return { success: true, providerMessageId: "none-provider-noop" };
  }
}

/**
 * Klaviyo adapter — UNVERIFIED, best-effort only.
 *
 * Implementation approach: tracks a custom Klaviyo event
 * ("Royalton Booking Link Ready") via the Klaviyo Events API, carrying the
 * access link and order name as event properties, on the assumption that
 * a Klaviyo Flow already exists in the client's account that:
 *   (a) triggers on this event,
 *   (b) is a transactional (not marketing-consent-gated) flow so it
 *       reaches customers regardless of marketing opt-in status, and
 *   (c) uses exactly the required subject/body/button copy.
 *
 * None of (a)-(c) can be confirmed from here — there is no Klaviyo
 * account access in this session. Building that flow is a Klaviyo-UI task
 * for whoever has dashboard access, not something this code can do. DO
 * NOT set EMAIL_PROVIDER=klaviyo in production until that flow exists and
 * has been test-sent. This is called out as a blocking Outstanding
 * Requirement in the Task 17 report.
 */
class KlaviyoEmailSender implements EmailSender {
  async sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult> {
    if (!config.email.klaviyoApiKey || !config.email.klaviyoListOrFlowId) {
      return {
        success: false,
        error:
          "Klaviyo not configured (KLAVIYO_PRIVATE_API_KEY / KLAVIYO_TRANSACTIONAL_FLOW_ID missing)",
      };
    }

    try {
      const response = await fetch("https://a.klaviyo.com/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${config.email.klaviyoApiKey}`,
          revision: "2024-10-15",
        },
        body: JSON.stringify({
          data: {
            type: "event",
            attributes: {
              properties: {
                access_page_url: params.accessPageUrl,
                order_name: params.orderName,
              },
              metric: { data: { type: "metric", attributes: { name: "Royalton Booking Link Ready" } } },
              profile: { data: { type: "profile", attributes: { email: to } } },
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { success: false, error: `Klaviyo API ${response.status}: ${body}` };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown Klaviyo error",
      };
    }
  }
}

/**
 * Omnisend adapter — same caveat as Klaviyo above: fires a custom event,
 * relies on an Omnisend automation already built to match it. UNVERIFIED.
 */
class OmnisendEmailSender implements EmailSender {
  async sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult> {
    if (!config.email.omnisendApiKey) {
      return { success: false, error: "Omnisend not configured (OMNISEND_API_KEY missing)" };
    }

    try {
      const response = await fetch("https://api.omnisend.com/v3/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": config.email.omnisendApiKey,
        },
        body: JSON.stringify({
          eventName: "royalton booking link ready",
          email: to,
          fields: {
            access_page_url: params.accessPageUrl,
            order_name: params.orderName,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { success: false, error: `Omnisend API ${response.status}: ${body}` };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown Omnisend error",
      };
    }
  }
}

/**
 * Recommended alternative: a dedicated transactional email API (Postmark,
 * SendGrid, Resend, Amazon SES, etc.) where this code supplies the exact
 * subject/HTML/text and the provider just relays it — no dependency on a
 * marketing flow being configured correctly. Implemented here as a single
 * generic SMTP-less HTTP sender is deliberately NOT included because no
 * such provider/credentials were specified; this is the recommendation
 * written up in the Task 17 report rather than guessed at in code.
 */

function getEmailSender(): EmailSender {
  switch (config.email.provider) {
    case "klaviyo":
      return new KlaviyoEmailSender();
    case "omnisend":
      return new OmnisendEmailSender();
    case "none":
      return new NoneEmailSender();
    default:
      // Fail LOUDLY, not silently. EMAIL_PROVIDER="smtp" is documented in
      // .env.example as a valid value but has no implementation yet (see
      // the comment above — a dedicated transactional provider is the
      // recommendation, not built here without real credentials to
      // integrate against). Any other unrecognized value is a typo.
      // Either way, silently falling back to the "none" (log-only)
      // provider would mean a real customer never receives their access
      // link with no error anywhere — the same "fail closed" discipline
      // this codebase uses everywhere else (see eligibility.ts,
      // admin-api.ts) applies here: an unusable config must be a loud
      // startup/runtime error, never a silent no-op.
      throw new Error(
        `EMAIL_PROVIDER="${config.email.provider}" is not implemented. ` +
          `Valid values: "klaviyo" | "omnisend" | "none". ("smtp" is ` +
          `documented as a future option but has no sender implementation ` +
          `yet — see src/lib/email.ts.)`
      );
  }
}

export async function sendAccessReadyEmail(
  to: string,
  params: AccessReadyEmailParams
): Promise<EmailSendResult> {
  const sender = getEmailSender();
  return sender.sendAccessReadyEmail(to, params);
}

/** Exposed for tests that want to assert on rendering without sending. */
export function renderAccessReadyEmailForTests(params: AccessReadyEmailParams) {
  return {
    subject: ACCESS_READY_EMAIL_SUBJECT,
    html: renderAccessReadyEmailHtml(params),
    text: renderAccessReadyEmailText(params),
  };
}

function redactUrlToken(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "…redacted");
    }
    return parsed.toString();
  } catch {
    return "[unparseable url]";
  }
}
