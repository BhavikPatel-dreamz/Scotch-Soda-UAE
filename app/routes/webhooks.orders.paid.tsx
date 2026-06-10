import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic,
  upsertShopifyOrderFromWebhook,
} from "../utils/order-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    console.log("[orders/paid] webhook route hit");
    console.log("[orders/paid] webhook headers", {
      topic: request.headers.get("x-shopify-topic"),
      shop: request.headers.get("x-shopify-shop-domain"),
      webhookId: request.headers.get("x-shopify-webhook-id"),
      hmacPresent: Boolean(request.headers.get("x-shopify-hmac-sha256")),
      contentType: request.headers.get("content-type"),
      userAgent: request.headers.get("user-agent"),
    });
    const { topic, shop, payload } = await authenticate.webhook(request);
    if (isOrderWebhookTopic(topic, "ORDERS_PAID")) {
      const order = await upsertShopifyOrderFromWebhook({
        shop,
        topic,
        payload: payload as Record<string, unknown>,
      });

      console.log(`Stored paid order ${order.shopifyOrderId} for shop ${shop}`);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[orders/paid] webhook authentication failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
}
