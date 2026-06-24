import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type BackfillResponse = {
  success: boolean;
  processed?: number;
  upserted?: number;
  stores?: Array<{
    shopDomain: string;
    action: "created" | "updated";
  }>;
  error?: string;
};

export const loader = async () => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, error: "Method not allowed" } as BackfillResponse,
      { status: 405 },
    );
  }

  await authenticate.admin(request);

  const url = new URL(request.url);
  const requestedShop = url.searchParams.get("shop") ?? undefined;

  const sessions = await prisma.session.findMany({
    where: {
      isOnline: false,
      ...(requestedShop ? { shop: requestedShop } : {}),
    },
    orderBy: { shop: "asc" },
  });

  const stores: Array<{
    shopDomain: string;
    action: "created" | "updated";
  }> = [];

  for (const session of sessions) {
    const existingStore = await prisma.store.findUnique({
      where: { shopDomain: session.shop },
      select: { id: true },
    });

    await prisma.store.upsert({
      where: { shopDomain: session.shop },
      update: {
        accessToken: session.accessToken,
        scope: session.scope ?? null,
        contactEmail: session.email ?? undefined,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken,
        scope: session.scope ?? null,
        contactEmail: session.email ?? undefined,
      },
    });

    stores.push({
      shopDomain: session.shop,
      action: existingStore ? "updated" : "created",
    });
  }

  return Response.json({
    success: true,
    processed: sessions.length,
    upserted: stores.length,
    stores,
  } as BackfillResponse);
};
