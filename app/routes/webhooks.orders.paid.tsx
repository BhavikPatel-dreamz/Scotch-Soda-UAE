import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic,
  upsertShopifyOrderFromWebhook,
} from "../utils/order-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    console.log(`[orders/paid] webhook received for shop ${shop} with topic ${topic}`);
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
    const requestHeaders = Object.fromEntries(request.headers.entries());
    let rawBodyLength: number | null = null;
    try {
      const rawBody = await request.clone().text();
      rawBodyLength = rawBody.length;
    } catch (bodyError) {
      console.warn("[orders/paid] failed to read request body for debug logging", bodyError);
    }

    console.error("[orders/paid] webhook authentication failed:", error, {
      headers: requestHeaders,
      rawBodyLength,
    });
    return new Response("Unauthorized", { status: 401 });
  }
}
