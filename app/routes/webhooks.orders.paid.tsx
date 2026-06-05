import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { upsertShopifyOrderFromWebhook } from "../utils/order-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "orders/paid") {
    const order = await upsertShopifyOrderFromWebhook({
      shop,
      topic,
      payload: payload as Record<string, unknown>,
    });

    console.log(`Stored paid order ${order.shopifyOrderId} for shop ${shop}`);
  }

  return new Response();
};
