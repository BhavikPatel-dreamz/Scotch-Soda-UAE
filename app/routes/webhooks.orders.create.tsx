import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isOrderWebhookTopic
} from "../utils/order-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    if (isOrderWebhookTopic(topic, "ORDERS_CREATE")) {
      console.log("[orders/create] authenticated webhook for shop:", shop);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[orders/create] webhook authentication failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
}
