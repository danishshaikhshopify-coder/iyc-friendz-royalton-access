import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-hmac";

const SECRET = "test-webhook-secret";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyShopifyWebhookHmac", () => {
  it("accepts a correctly signed raw body", () => {
    const body = JSON.stringify({ id: 123, financial_status: "paid" });
    const signature = sign(body, SECRET);
    expect(verifyShopifyWebhookHmac(body, signature, SECRET)).toEqual({ valid: true });
  });

  it("rejects a tampered body (bit-for-bit — this is why raw body matters)", () => {
    const original = JSON.stringify({ id: 123, financial_status: "paid" });
    const tampered = JSON.stringify({ id: 123, financial_status: "refunded" });
    const signature = sign(original, SECRET);
    const result = verifyShopifyWebhookHmac(tampered, signature, SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects when the signing secret doesn't match", () => {
    const body = JSON.stringify({ id: 123 });
    const signature = sign(body, "wrong-secret");
    const result = verifyShopifyWebhookHmac(body, signature, SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhookHmac(body, null, SECRET)).toEqual({
      valid: false,
      reason: "missing_signature_header",
    });
    expect(verifyShopifyWebhookHmac(body, undefined, SECRET)).toEqual({
      valid: false,
      reason: "missing_signature_header",
    });
  });

  it("rejects a non-base64 signature without throwing", () => {
    const body = JSON.stringify({ id: 123 });
    expect(() => verifyShopifyWebhookHmac(body, "not valid base64!!", SECRET)).not.toThrow();
  });

  it("a single whitespace byte difference invalidates the signature (why raw body bytes matter)", () => {
    const rawBody = `{"id":123,"financial_status":"paid"}`;
    const signature = sign(rawBody, SECRET);

    // Simulates re-serializing (e.g. via request.json() + JSON.stringify())
    // instead of using the exact bytes Shopify sent via request.text().
    const reformatted = `{ "id": 123, "financial_status": "paid" }`;

    expect(verifyShopifyWebhookHmac(rawBody, signature, SECRET).valid).toBe(true);
    expect(verifyShopifyWebhookHmac(reformatted, signature, SECRET).valid).toBe(false);
  });
});
