import prisma from "../db.server";

type StoreRequestBody = Record<string, unknown> | undefined;

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

export function normalizeShopDomain(
  value: string | null | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split("/")[0];
  return withoutPath || undefined;
}

export function toShopifyCustomerGid(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/Customer/${id}`;
}

export async function resolveCurrentShop(
  request: Request,
  body?: StoreRequestBody,
): Promise<string | null> {
  const requestUrl = new URL(request.url);

  const shopFromBody = normalizeShopDomain(
    extractStringValue(body?.shop) ??
      extractStringValue(body?.shopDomain) ??
      extractStringValue(body?.myshopifyDomain) ??
      extractStringValue(body?.storeDomain),
  );
  if (shopFromBody) {
    return shopFromBody;
  }

  const shopFromHeader = normalizeShopDomain(
    request.headers.get("x-shopify-shop-domain") ??
      request.headers.get("shop") ??
      request.headers.get("x-shop-domain") ??
      request.headers.get("x-shop-domain-name") ??
      request.headers.get("origin") ??
      request.headers.get("referer"),
  );
  if (shopFromHeader) {
    return shopFromHeader;
  }

  const shopFromQuery = normalizeShopDomain(
    requestUrl.searchParams.get("shop") ??
      requestUrl.searchParams.get("shopDomain") ??
      requestUrl.searchParams.get("storeDomain"),
  );
  if (shopFromQuery) {
    return shopFromQuery;
  }

  const session = await prisma.session.findFirst({
    where: { isOnline: false },
    orderBy: { shop: "asc" },
  });

  return session?.shop ?? null;
}

export async function ensureStoreRecord(
  request: Request,
  body?: StoreRequestBody,
): Promise<string | null> {
  const shop = await resolveCurrentShop(request, body);
  if (!shop) {
    return null;
  }

  const session = await prisma.session.findFirst({
    where: {
      shop,
      isOnline: false,
    },
  });

  await prisma.store.upsert({
    where: { shopDomain: shop },
    update: {
      ...(session?.accessToken ? { accessToken: session.accessToken } : {}),
      ...(session?.scope ? { scope: session.scope } : {}),
      ...(session?.email ? { contactEmail: session.email } : {}),
    },
    create: {
      shopDomain: shop,
      ...(session?.accessToken ? { accessToken: session.accessToken } : {}),
      ...(session?.scope ? { scope: session.scope } : {}),
      ...(session?.email ? { contactEmail: session.email } : {}),
    },
  });
  return shop;
}
