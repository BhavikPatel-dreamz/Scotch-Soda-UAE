import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "customers/create") {
    console.log(`Received customers/create webhook for shop: ${shop}`);
    console.log("Customer create payload:", payload);
  }

  return new Response();
};
