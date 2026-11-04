/**
 * Shopify Admin GraphQL API client — used to fetch LIVE order status at
 * the moment of an access request. This is the source of truth for
 * eligibility; webhook-delivered data is only ever used to decide whether
 * to mint a token and send an email, never as the final access decision
 * (see src/lib/eligibility.ts and the App Proxy route).
 *
 * Required scope: read_orders only. No write scope is used anywhere in
 * this service.
 */

import { config } from "@/lib/config";
import { getValidAccessToken } from "@/lib/shopify-oauth";

export interface OrderLineItemData {
  productHandle: string | null;
  quantity: number;
}

export interface OrderEligibilityData {
  orderGid: string;
  name: string;
  displayFinancialStatus: string; // e.g. PAID, PARTIALLY_REFUNDED, REFUNDED, VOIDED, PENDING
  cancelledAt: string | null;
  lineItems: OrderLineItemData[];
}

export class AdminApiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AdminApiError";
  }
}

const ORDER_QUERY = `
  query OrderEligibility($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      cancelledAt
      lineItems(first: 100) {
        edges {
          node {
            quantity
            product {
              handle
            }
          }
        }
      }
    }
  }
`;

/**
 * Converts a numeric Shopify order id (as delivered in a webhook payload's
 * `id` field) into the GraphQL global id format. If the webhook payload's
 * `admin_graphql_api_id` field is available, prefer passing that directly
 * instead of calling this.
 */
export function orderGidFromNumericId(numericId: string | number): string {
  return `gid://shopify/Order/${numericId}`;
}

export interface AdminApiClient {
  fetchOrderEligibilityData(orderGid: string): Promise<OrderEligibilityData>;
}

/**
 * Real implementation, backed by a network call to the Shopify Admin
 * GraphQL API. Any network failure, non-200 response, or GraphQL error is
 * surfaced as an AdminApiError — callers must treat that as "could not
 * verify eligibility" and deny access (fail closed), never as an implicit
 * pass.
 */
export const shopifyAdminApiClient: AdminApiClient = {
  async fetchOrderEligibilityData(orderGid: string): Promise<OrderEligibilityData> {
    const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.adminApiVersion}/graphql.json`;

    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(config.shopify.shopDomain);
    } catch (err) {
      // No installation, revoked, or an expired token with no refresh
      // token available — treat identically to any other Admin API
      // failure: fail closed, never an implicit pass.
      throw new AdminApiError("Could not obtain a valid Shopify access token", err);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: ORDER_QUERY, variables: { id: orderGid } }),
      });
    } catch (err) {
      throw new AdminApiError("Network error calling Shopify Admin API", err);
    }

    if (!response.ok) {
      throw new AdminApiError(
        `Shopify Admin API returned HTTP ${response.status}`
      );
    }

    let json: {
      data?: {
        order: {
          id: string;
          name: string;
          displayFinancialStatus: string;
          cancelledAt: string | null;
          lineItems: {
            edges: Array<{
              node: { quantity: number; product: { handle: string } | null };
            }>;
          };
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    try {
      json = await response.json();
    } catch (err) {
      throw new AdminApiError("Could not parse Shopify Admin API response", err);
    }

    if (json.errors && json.errors.length > 0) {
      throw new AdminApiError(
        `Shopify Admin API GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }

    const order = json.data?.order;
    if (!order) {
      throw new AdminApiError(`Order not found: ${orderGid}`);
    }

    return {
      orderGid: order.id,
      name: order.name,
      displayFinancialStatus: order.displayFinancialStatus,
      cancelledAt: order.cancelledAt,
      lineItems: order.lineItems.edges.map((edge) => ({
        productHandle: edge.node.product?.handle ?? null,
        quantity: edge.node.quantity,
      })),
    };
  },
};
