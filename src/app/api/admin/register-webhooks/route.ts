/**
 * TEMPORARY — Task 17 one-time webhook registration trigger.
 *
 * Exists only because the app's secret-shaped Production env vars are
 * Vercel "Sensitive" variables, which cannot be read back through any
 * CLI (`vercel env pull` / `vercel env run`) but ARE available inside the
 * deployed runtime itself. This route runs the same idempotent
 * registerWebhooks() logic as scripts/register-webhooks.ts, server-side,
 * where those variables are actually readable.
 *
 * Gated by ADMIN_REGISTRATION_SECRET (a throwaway secret set only for
 * this), compared with a timing-safe check. Delete this file (and the
 * env var) once registration is confirmed — it is not part of the
 * ongoing application.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { registerWebhooks } from "@/lib/webhook-registration";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST(request: NextRequest) {
  const expected = process.env.ADMIN_REGISTRATION_SECRET;
  const provided = request.headers.get("x-admin-secret");

  if (!expected || !provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const results = await registerWebhooks(request.nextUrl.origin);
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return NextResponse.json(
      { error: "registration_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
