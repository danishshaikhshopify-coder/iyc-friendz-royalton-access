/**
 * Temporary, secret-gated admin endpoint to recover access for an order
 * whose grant exists but whose access email was never actually
 * delivered (see src/lib/access-recovery.ts). Same pattern as the
 * webhook-registration admin endpoint used earlier in this project:
 * timing-safe shared-secret header, Vercel-runtime env vars only, no
 * secrets ever returned. Delete this route once it's no longer needed —
 * it is not meant to be a permanent part of the app's surface.
 *
 * Invoke with (never from a client — server-to-server only):
 *   POST /api/admin/recover-access
 *   Header: x-admin-secret: <ADMIN_RECOVERY_SECRET>
 *   Body:   {"orderId":"..."}
 *
 * Deliberately takes no email/name in the body — recoverAccessForOrder
 * always sends to the order's own email, fetched fresh from Shopify, so
 * this endpoint cannot be used to redirect an access link to an
 * arbitrary address.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { recoverAccessForOrder } from "@/lib/access-recovery";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.ADMIN_RECOVERY_SECRET;
  const provided = request.headers.get("x-admin-secret");
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

interface RecoverAccessBody {
  orderId?: string;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RecoverAccessBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.orderId) {
    return NextResponse.json({ error: "missing_order_id" }, { status: 400 });
  }

  const result = await recoverAccessForOrder(config.shopify.shopDomain, body.orderId);

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
