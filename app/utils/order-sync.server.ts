import prisma from "../db.server";
import type { Prisma } from "@prisma/client";

type ShopifyOrderPayload = Record<string, unknown>;

type SyncOrderOptions = {
  shop: string;
  topic: string;
  payload: ShopifyOrderPayload;
};

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

function extractCustomerId(payload: ShopifyOrderPayload): string | undefined {
  const customer = payload.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return undefined;
  }

  return asString((customer as Record<string, unknown>).id);
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

function deriveErpStatus(topic: string): string {
  return topic === "orders/paid" ? "PENDING" : "PENDING";
}

function deriveLoyaltyStatus(topic: string): string {
  return topic === "orders/paid" ? "NOT_POSTED" : "NOT_POSTED";
}

export async function upsertShopifyOrderFromWebhook({
  shop,
  topic,
  payload,
}: SyncOrderOptions) {
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

  return await prisma.order.upsert({
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
      lastWebhookTopic: topic,
      erpStatus: deriveErpStatus(topic),
      loyaltyStatus: deriveLoyaltyStatus(topic),
      paidAt: topic === "orders/paid" ? paidAt : undefined,
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
      lastWebhookTopic: topic,
      paidAt: topic === "orders/paid" ? paidAt : undefined,
      rawPayload,
    },
  });
}
