/**
 * Email delivery abstraction.
 *
 * Why an abstraction at all: this service must send one transactional,
 * per-customer email containing a unique access link. Omnisend (the
 * chosen production provider) is an event/automation-driven marketing
 * tool, not a direct transactional-send API — this code fires a
 * dedicated Custom Event and relies on an Automation already built in
 * the Omnisend dashboard to actually deliver the email. That dashboard
 * setup can't be done from here; see OmnisendEmailSender's comment below
 * and the "remaining setup" item in the Task 17 report.
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
 *
 * Reports success: false. It used to report true, which let the app
 * record email_sent=1 for a customer who never actually received
 * anything (the bug this fixed) — "none" is a no-op, not a delivery, and
 * must never be mistaken for one by any caller.
 */
class NoneEmailSender implements EmailSender {
  async sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult> {
    // eslint-disable-next-line no-console
    console.log("[email:none] Would send access-ready email (NOT actually sent)", {
      to,
      subject: ACCESS_READY_EMAIL_SUBJECT,
      orderName: params.orderName,
      // Never log the raw access URL containing the token in production
      // logs; for the local "none" provider this is acceptable since
      // nothing here is a real customer or a real token, but we still
      // redact to keep the dev/prod code paths identical in behavior.
      accessPageUrl: redactUrlToken(params.accessPageUrl),
    });
    return {
      success: false,
      error: "EMAIL_PROVIDER=none: no-op, no email was actually sent",
    };
  }
}

/** Network timeout shared by the HTTP-based provider adapters below. */
const PROVIDER_TIMEOUT_MS = 10_000;

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
 * Current API version pinned in the Omnisend-Version header, per
 * https://api-docs.omnisend.com/reference/post_events (checked against
 * the live docs, not the deprecated v3/v5 examples still floating
 * around). Bump deliberately, not as a side effect of an unrelated
 * change — a version bump can change response shape/behavior.
 */
const OMNISEND_API_VERSION = "2026-03-15";

/** Shape of Omnisend's documented 400 Validation failed response body. */
interface OmnisendValidationProblem {
  title?: string;
  detail?: string;
  errors?: { field?: string; message?: string }[];
}

function describeOmnisendError(status: number, bodyText: string): string {
  try {
    const problem = JSON.parse(bodyText) as OmnisendValidationProblem;
    const firstFieldError = problem.errors?.[0];
    const detail =
      (firstFieldError && `${firstFieldError.field}: ${firstFieldError.message}`) ||
      problem.detail ||
      problem.title;
    return detail ? `Omnisend API ${status}: ${detail}` : `Omnisend API ${status}`;
  } catch {
    return `Omnisend API ${status}: ${bodyText}`;
  }
}

/**
 * Omnisend adapter — the chosen production provider. Fires a dedicated
 * Custom Event (`royalton_access_ready`, distinct from any marketing
 * event name) carrying the verified recipient email and the access URL,
 * via Omnisend's current Events API: POST
 * https://api.omnisend.com/api/events (NOT the deprecated /v3/events or
 * /v5/events). An Omnisend Automation keyed to this exact event name
 * must exist in the account to actually deliver an email — that's a
 * dashboard-side task, not something this code can create, and is
 * called out as a remaining setup item. This event name is deliberately
 * separate from the store's existing Order Confirmation / post-purchase
 * automations, which this code never touches.
 *
 * The API's only documented success response is 202 Accepted, meaning
 * the event was accepted for processing — it is NOT proof the
 * automation ran or that an inbox received anything. We only ever
 * report success for exactly a 202; any other status (including any
 * other 2xx, since none is documented) is treated as a failure so a
 * silent provider-side problem doesn't get recorded as a delivered
 * email.
 */
class OmnisendEmailSender implements EmailSender {
  async sendAccessReadyEmail(
    to: string,
    params: AccessReadyEmailParams
  ): Promise<EmailSendResult> {
    if (!config.email.omnisendApiKey) {
      return { success: false, error: "Omnisend not configured (OMNISEND_API_KEY missing)" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetch("https://api.omnisend.com/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Omnisend-API-Key ${config.email.omnisendApiKey}`,
          "Omnisend-Version": OMNISEND_API_VERSION,
        },
        body: JSON.stringify({
          eventName: "royalton_access_ready",
          origin: "api",
          contact: { email: to },
          properties: {
            access_page_url: params.accessPageUrl,
            order_name: params.orderName,
          },
        }),
        signal: controller.signal,
      });

      if (response.status !== 202) {
        const body = await response.text().catch(() => "");
        return { success: false, error: describeOmnisendError(response.status, body) };
      }

      return { success: true };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return {
        success: false,
        error: isTimeout
          ? "Omnisend request timed out (delivery outcome unknown)"
          : err instanceof Error
            ? err.message
            : "Unknown Omnisend error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

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
          `Valid values: "omnisend" | "klaviyo" | "none". ` +
          `("smtp" is documented as a future option but has no sender ` +
          `implementation yet — see src/lib/email.ts.)`
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
