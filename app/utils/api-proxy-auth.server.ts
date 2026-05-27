import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeShopDomain } from "./store.server";

type ApiProxyContext = {
  customerId: string | null;
  shop: string;
  store: {
    accessToken: string | null;
    shopDomain: string;
  };
};

function getProxyCustomerId(url: URL): string | null {
  return (
    url.searchParams.get("logged_in_customer_id") ??
    url.searchParams.get("customer_id")
  );
}


function getProxyShop(url: URL): string | null {
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  return shop ?? null;
}

function hasAppProxySignature(url: URL): boolean {
  return Boolean(
    url.searchParams.get("signature") ?? url.searchParams.get("hmac"),
  );
}

export async function authenticateApiProxyRequest(
  request: Request,
): Promise<ApiProxyContext | undefined> {
  const url = new URL(request.url);

  // Some routes are called both through the Shopify app proxy and directly
  // from storefront code. Skip proxy verification when the signed params
  // are not present so we do not emit avoidable Shopify auth warnings.
  if (!hasAppProxySignature(url)) {
    return undefined;
  }

  await authenticate.public.appProxy(request);

  const customerId = getProxyCustomerId(url);
  console.log("Extracted customerId from URL:", customerId);
  const shop = getProxyShop(url);

  if (!shop) {
    throw Response.json(
      { error: "Shop parameter is required" },
      { status: 400 },
    );
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
  });
  console.log("Store record found for shop", shop, store);

  if (!store?.accessToken) {
    throw Response.json(
      { error: "Store not found or unauthorized" },
      { status: 404 },
    );
  }

  return {
    customerId,
    shop,
    store,
  };
}

export function getApiProxyCustomerId(request: Request): string | null {
  return getProxyCustomerId(new URL(request.url));
}

export function getApiProxyShop(request: Request): string | null {
  return getProxyShop(new URL(request.url));
}
