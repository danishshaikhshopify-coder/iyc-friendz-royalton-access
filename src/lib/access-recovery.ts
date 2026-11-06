/**
 * Recovers access for an order whose grant already exists but whose
 * access email was never actually delivered (e.g. the "none" provider's
 * no-op, or a genuine send failure) — without creating a second grant or
 * a second Shopify order.
 *
 * Rotates the grant's token before sending: the raw token is never
 * persisted anywhere (see src/lib/token.ts), so there is no way to
 * "resend the same link" — only to mint a fresh one and invalidate the
 * old. That's not a loss here: by definition this function only ever
 * runs for a grant whose previous raw token was never delivered, so
 * nothing usable is being revoked.
 *
 * Re-validates live eligibility before sending, exactly like the
 * orders/paid webhook — a grant created when an order was eligible can
 * still have since become ineligible (cancelled, refunded).
 */
import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import { shopifyAdminApiClient, orderGidFromNumericId } from "@/lib/admin-api";
import { checkOrderEligibility } from "@/lib/eligibility";
import {
  findAccessGrantByOrder,
  rotateAccessGrantToken,
  markAccessGrantEmailSent,
  markAccessGrantEmailFailed,
} from "@/lib/access-grants";
import { generateAccessToken, hashToken } from "@/lib/token";
import { buildAccessPageUrl } from "@/lib/access-url";
import { sendAccessReadyEmail } from "@/lib/email";

export type RecoveryFailureReason =
  | "no_existing_grant"
  | "grant_revoked"
  | `not_eligible:${string}`
  | `send_failed:${string}`;

export type RecoveryResult =
  | { ok: true }
  | { ok: false; reason: RecoveryFailureReason };

export async function recoverAccessForOrder(
  shopDomain: string,
  orderId: string,
  customerEmail: string,
  orderName?: string
): Promise<RecoveryResult> {
  const grant = await findAccessGrantByOrder(shopDomain, orderId);
  if (!grant) {
    return { ok: false, reason: "no_existing_grant" };
  }
  if (grant.revoked) {
    return { ok: false, reason: "grant_revoked" };
  }

  const orderGid = orderGidFromNumericId(orderId);
  const orderData = await shopifyAdminApiClient.fetchOrderEligibilityData(orderGid);
  const verdict = checkOrderEligibility(orderData, {
    eventPassProductHandle: config.shopify.eventPassProductHandle,
    partialRefundPolicy: config.partialRefundPolicy,
  });
  if (!verdict.eligible) {
    return { ok: false, reason: `not_eligible:${verdict.reason}` };
  }

  const rawToken = generateAccessToken();
  const tokenHash = hashToken(rawToken, config.tokens.signingSecret);
  await rotateAccessGrantToken(shopDomain, orderId, tokenHash);

  const accessPageUrl = buildAccessPageUrl(rawToken);
  const idempotencyKey = createHash("sha256")
    .update(`${shopDomain}:${orderId}:${tokenHash}`)
    .digest("hex");

  const result = await sendAccessReadyEmail(
    customerEmail,
    { accessPageUrl, orderName: orderName ?? orderId },
    idempotencyKey
  );

  if (!result.success) {
    await markAccessGrantEmailFailed(shopDomain, orderId, result.error ?? "unknown error");
    return { ok: false, reason: `send_failed:${result.error ?? "unknown"}` };
  }

  await markAccessGrantEmailSent(shopDomain, orderId);
  return { ok: true };
}
