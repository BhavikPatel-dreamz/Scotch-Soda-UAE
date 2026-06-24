import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic
} from "../utils/order-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (isOrderWebhookTopic(topic, "ORDERS_UPDATED")) {
    // const order = await upsertShopifyOrderFromWebhook({
    //   shop,
    //   topic,
    //   payload: payload as Record<string, unknown>,
    // });

    console.log("[orders/updated] authenticated webhook for shop:", shop);
  }

  return new Response();
};
