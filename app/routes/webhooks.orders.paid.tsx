import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic,
  upsertShopifyOrderFromWebhook,
} from "../utils/order-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
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
