import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic,
  upsertShopifyOrderFromWebhook,
} from "../utils/order-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    console.log("[orders/cancelled] webhook route hit");
    const { topic, shop, payload } = await authenticate.webhook(request);

    if (isOrderWebhookTopic(topic, "ORDERS_CANCELLED")) {
      const order = await upsertShopifyOrderFromWebhook({
        shop,
        topic,
        payload: payload as Record<string, unknown>,
      });

      console.log(
        `Stored cancelled order ${order.shopifyOrderId} for shop ${shop}`,
      );
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[orders/cancelled] webhook authentication failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
};
