import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "orders/updated") {
    console.log(`Received orders/updated webhook for shop: ${shop}`);
    console.log("Order update payload:", payload);
  }

  return new Response();
};
