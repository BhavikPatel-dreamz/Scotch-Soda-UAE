import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "shop/update") {
    console.log(`Received shop/update webhook for shop: ${shop}`);

    const shopData = payload as {
      name?: string;
      email?: string;
    };

    await db.store.upsert({
      where: { shopDomain: shop },
      update: {
        shopName: shopData.name ?? null,
        contactEmail: shopData.email ?? null,
      },
      create: {
        shopDomain: shop,
        shopName: shopData.name ?? null,
        contactEmail: shopData.email ?? null,
      },
    });
  }

  return new Response();
};
