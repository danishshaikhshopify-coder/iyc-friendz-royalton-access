/**
 * Shared logic for registering this app's required webhook topics on the
 * configured shop, via the Admin GraphQL API, using the stored OAuth
 * offline token. Used by both scripts/register-webhooks.ts (CLI) and the
 * temporary authenticated admin route.
 *
 * Idempotent: for each topic, first queries existing subscriptions and
 * skips creation if one already points at the correct callback URL — safe
 * to call any number of times, never creates duplicates.
 */
import { config } from "@/lib/config";
import { getValidAccessToken } from "@/lib/shopify-oauth";

export const REQUIRED_WEBHOOK_TOPICS: Array<{ topic: string; path: string }> = [
  { topic: "ORDERS_PAID", path: "/api/webhooks/orders-paid" },
  { topic: "ORDERS_CANCELLED", path: "/api/webhooks/orders-cancelled" },
  { topic: "REFUNDS_CREATE", path: "/api/webhooks/refunds-create" },
  { topic: "APP_UNINSTALLED", path: "/api/webhooks/app-uninstalled" },
];

interface ExistingSubscription {
  id: string;
  topic: string;
  endpoint: { __typename: string; callbackUrl?: string };
}

export interface WebhookRegistrationResult {
  topic: string;
  callbackUrl: string;
  status: "created" | "already_registered";
  id: string | null;
}

async function adminGraphql<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.adminApiVersion}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Admin API returned HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`Admin API GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join("; ")}`);
  }
  return json.data as T;
}

const LIST_QUERY = `
  query ExistingWebhooks {
    webhookSubscriptions(first: 50) {
      edges {
        node {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

export async function registerWebhooks(baseUrl: string): Promise<WebhookRegistrationResult[]> {
  const accessToken = await getValidAccessToken(config.shopify.shopDomain);

  const { webhookSubscriptions } = await adminGraphql<{
    webhookSubscriptions: { edges: Array<{ node: ExistingSubscription }> };
  }>(accessToken, LIST_QUERY, {});
  const existing = webhookSubscriptions.edges.map((e) => e.node);

  const results: WebhookRegistrationResult[] = [];

  for (const { topic, path } of REQUIRED_WEBHOOK_TOPICS) {
    const callbackUrl = `${baseUrl}${path}`;
    const alreadyRegistered = existing.find(
      (sub) => sub.topic === topic && sub.endpoint.callbackUrl === callbackUrl
    );
    if (alreadyRegistered) {
      results.push({ topic, callbackUrl, status: "already_registered", id: alreadyRegistered.id });
      continue;
    }

    const result = await adminGraphql<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string; topic: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(accessToken, CREATE_MUTATION, { topic, callbackUrl });

    const { webhookSubscription, userErrors } = result.webhookSubscriptionCreate;
    if (userErrors.length > 0) {
      throw new Error(`Failed to register ${topic}: ${userErrors.map((e) => e.message).join("; ")}`);
    }
    results.push({ topic, callbackUrl, status: "created", id: webhookSubscription?.id ?? null });
  }

  return results;
}
