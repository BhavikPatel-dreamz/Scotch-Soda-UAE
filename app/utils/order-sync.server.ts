import prisma from "../db.server";
import type { Prisma } from "@prisma/client";
import { QIVOS_BESIDE_API_BASE_URL } from "./constants";
import {
  getCustomerIdentityMetafields,
  saveCustomerIdentityMetafields,
} from "./shopify-customer-metafields.server";
import { getQIVOSToken, refreshQIVOSToken } from "./qivos-token.server";
import { toShopifyCustomerGid } from "./store.server";

type ShopifyOrderPayload = Record<string, unknown>;

type SyncOrderOptions = {
  shop: string;
  topic: string;
  payload: ShopifyOrderPayload;
};

const ORDER_WEBHOOK_TOPICS = {
  created: "ORDERS_CREATE",
  paid: "ORDERS_PAID",
  cancelled: "ORDERS_CANCELLED",
  updated: "ORDERS_UPDATED",
} as const;

type ReservePointsBody = {
  loyaltyMemberCode: string;
  orderNumber: string;
  pointsToReserve: number;
  reservationType: string;
};

const QIVOS_RESERVE_POINTS_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/pointlogs/reserve-points`;

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asMoneyString(value: unknown): string | undefined {
  const directValue = asString(value);
  if (directValue) {
    return directValue;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return (
    asString(record.amount) ??
    asString(record.value) ??
    asString(record.price) ??
    asString(record.currency_amount)
  );
}

function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function findNumericField(
  value: unknown,
  candidateKeys: string[],
): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findNumericField(item, candidateKeys);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of candidateKeys) {
    const directValue = asNumber(record[key]);
    if (directValue !== undefined) {
      return directValue;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findNumericField(nestedValue, candidateKeys);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function toUpdatedRedeemPoint(
  currentRedeemPoint: string | undefined,
  reservedPoints: number,
  responseData: unknown,
): string | undefined {
  const qivosBalance = findNumericField(responseData, [
    "pointBalance",
    "redeemPoint",
    "redeem_point",
    "balance",
    "availablePoints",
  ]);

  if (qivosBalance !== undefined) {
    return String(Math.max(0, Math.round(qivosBalance)));
  }

  const currentBalance = asNumber(currentRedeemPoint);
  if (currentBalance === undefined) {
    return undefined;
  }

  return String(Math.max(0, Math.round(currentBalance - reservedPoints)));
}

function extractCustomerId(payload: ShopifyOrderPayload): string | undefined {
  const customer = payload.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return undefined;
  }

  return toShopifyCustomerGid(asString((customer as Record<string, unknown>).id));
}

function extractCustomerEmail(payload: ShopifyOrderPayload): string | undefined {
  return asString(payload.email) ?? undefined;
}

function extractOrderNumber(payload: ShopifyOrderPayload): string | undefined {
  return (
    asString(payload.order_number) ??
    asString(payload.name) ??
    asString(payload.orderNumber)
  );
}

function extractShopifyOrderId(payload: ShopifyOrderPayload): string | null {
  return asString(payload.id) ?? null;
}

function toPositiveWholeNumber(value: string | undefined): number | null {
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const rounded = Math.round(parsed); // Example: 1 currency unit = 10 points
  return rounded > 0 ? rounded : null;
}

function deriveErpStatus(topic: string): string {
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (normalizedTopic === ORDER_WEBHOOK_TOPICS.cancelled) {
    return "CANCELLED";
  }

  return "PENDING";
}

function deriveLoyaltyStatus(topic: string): string {
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (normalizedTopic === ORDER_WEBHOOK_TOPICS.cancelled) {
    return "CANCELLED";
  }

  return "NOT_POSTED";
}

export function normalizeWebhookTopic(topic: string): string {
  return topic.replaceAll("/", "_").toUpperCase();
}

export function isOrderWebhookTopic(topic: string, expected: string): boolean {
  return normalizeWebhookTopic(topic) === expected;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : null;
  }
}

async function sendQivosRequestWithRetry(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  async function execute(requestToken: string) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("x-jwt-token", requestToken);

    if (init.body !== undefined && init.body !== null && init.body !== "") {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url, {
      ...init,
      headers,
    });
  }

  let response = await execute(token);

  if (response.status === 401) {
    const refreshedToken = await refreshQIVOSToken();
    response = await execute(refreshedToken);
  }

  return response;
}

async function reserveQivosPoints({
  loyaltyMemberCode,
  orderNumber,
  pointsToReserve,
  reservationType,
}: ReservePointsBody): Promise<unknown> {
  const token = await getQIVOSToken();

  const response = await sendQivosRequestWithRetry(
    QIVOS_RESERVE_POINTS_URL,
    {
      method: "POST",
      body: JSON.stringify({
        loyaltyMemberCode,
        orderNumber,
        pointsToReserve,
        reservationType,
      }),
    },
    token,
  );

  const responseData = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `QIVOS reserve-points failed (${response.status}): ${JSON.stringify(responseData)}`,
    );
  }

  return responseData;
}

export async function upsertShopifyOrderFromWebhook({
  shop,
  topic,
  payload,
}: SyncOrderOptions) {
  const normalizedTopic = normalizeWebhookTopic(topic);
  const shopifyOrderId = extractShopifyOrderId(payload);
  if (!shopifyOrderId) {
    throw new Error("Shopify order payload is missing id");
  }

  const rawPayload = payload as Prisma.InputJsonValue;
  const orderName = asString(payload.name);
  const orderNumber = extractOrderNumber(payload);
  const customerShopifyId = extractCustomerId(payload);
  const customerEmail = extractCustomerEmail(payload);
  const currency = asString(payload.currency);
  const subtotalPrice =
    asMoneyString(payload.current_subtotal_price) ??
    asMoneyString(payload.subtotal_price);
  const totalPrice =
    asMoneyString(payload.current_total_price) ?? asMoneyString(payload.total_price);
  const discountTotal = asMoneyString(payload.total_discounts);
  const financialStatus = asString(payload.financial_status);
  const fulfillmentStatus = asString(payload.fulfillment_status);
  const paidAt = asDate(payload.processed_at) ?? new Date();
  const order = await prisma.order.upsert({
    where: {
      shopDomain_shopifyOrderId: {
        shopDomain: shop,
        shopifyOrderId,
      },
    },
    create: {
      shopDomain: shop,
      shopifyOrderId,
      orderName,
      orderNumber,
      customerShopifyId,
      customerEmail,
      currency,
      subtotalPrice,
      totalPrice,
      discountTotal,
      financialStatus,
      fulfillmentStatus,
      lastWebhookTopic: normalizedTopic,
      erpStatus: deriveErpStatus(normalizedTopic),
      loyaltyStatus: deriveLoyaltyStatus(normalizedTopic),
      paidAt: normalizedTopic === ORDER_WEBHOOK_TOPICS.paid ? paidAt : undefined,
      rawPayload,
    },
    update: {
      orderName,
      orderNumber,
      customerShopifyId,
      customerEmail,
      currency,
      subtotalPrice,
      totalPrice,
      discountTotal,
      financialStatus,
      fulfillmentStatus,
      lastWebhookTopic: normalizedTopic,
      erpStatus: deriveErpStatus(normalizedTopic),
      loyaltyStatus: deriveLoyaltyStatus(normalizedTopic),
      paidAt: normalizedTopic === ORDER_WEBHOOK_TOPICS.paid ? paidAt : undefined,
      rawPayload,
    },
  });

  if (normalizedTopic === ORDER_WEBHOOK_TOPICS.paid && customerShopifyId) {
    console.log(`[orders/paid] Processing paid order ${shopifyOrderId} for customer ${customerShopifyId}`);
    try {
      const customerMetafields = await getCustomerIdentityMetafields({
        shop,
        customerId: customerShopifyId,
      });

      const loyaltyMemberCode = customerMetafields.loyaltyQCCode;
      const pointsToReserve = toPositiveWholeNumber(totalPrice); // Example: 1 currency unit = 10 points

      if (!loyaltyMemberCode) {
        console.log(
          `[orders/paid] Skipping QIVOS reserve-points for order ${shopifyOrderId}: missing loyaltyQCCode`,
        );
      } else if (!pointsToReserve) {
        console.log(
          `[orders/paid] Skipping QIVOS reserve-points for order ${shopifyOrderId}: invalid totalPrice`,
        );
      } else {
        const reserveResponse = await reserveQivosPoints({
          loyaltyMemberCode,
          orderNumber: orderNumber ?? shopifyOrderId,
          pointsToReserve: pointsToReserve, // Convert to points
          reservationType: "REDEEM",
        });
        const reservedPoints = pointsToReserve * 10;
        const updatedRedeemPoint = toUpdatedRedeemPoint(
          customerMetafields.redeemPoint,
          reservedPoints,
          reserveResponse,
        );

        if (updatedRedeemPoint !== undefined) {
          await saveCustomerIdentityMetafields({
            shop,
            customerId: customerShopifyId,
            values: {
              redeemPoint: updatedRedeemPoint,
            },
          });
        } else {
          console.warn(
            `[orders/paid] Skipping redeem_point metafield update for order ${shopifyOrderId}: unable to determine updated balance`,
          );
        }

        await prisma.order.update({
          where: {
            shopDomain_shopifyOrderId: {
              shopDomain: shop,
              shopifyOrderId,
            },
          },
          data: {
            loyaltyStatus: "RESERVED",
          },
        });

        console.log("[orders/paid] QIVOS reserve-points success:", {
          shop,
          shopifyOrderId,
          orderNumber: orderNumber ?? shopifyOrderId,
          pointsToReserve,
          reserveResponse,
        });
      }
    } catch (error) {
      console.warn("[orders/paid] QIVOS reserve-points failed:", error);
    }
  } else if (normalizedTopic === ORDER_WEBHOOK_TOPICS.cancelled) {
    console.warn(
      `[orders/cancelled] Order ${shopifyOrderId} was cancelled. Shopify order state updated, but QIVOS point reversal is not implemented in this codebase yet.`,
    );
  }

  return order;
}
