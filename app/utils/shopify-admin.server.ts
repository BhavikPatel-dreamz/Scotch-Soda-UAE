import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

type ShopifyTokenRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

/**
 * Expiring offline access tokens live for 60 minutes, so refresh a few minutes
 * before the stored expiry rather than waiting for the first 401.
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Refresh tokens rotate on every use — two concurrent refreshes for the same
 * shop would race and invalidate each other, so callers share one in-flight
 * refresh per shop.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

async function getStoreAccessToken(shop: string): Promise<string | null> {
  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: { accessToken: true },
  });
  return store?.accessToken ?? null;
}

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
  usedStoredAccessToken?: boolean;
};

export async function getAdminGraphqlClient(
  shop: string,
): Promise<AdminGraphqlClient> {
  return createFallbackGraphqlClient(shop);
}

async function createFallbackGraphqlClient(
  shop: string,
): Promise<AdminGraphqlClient> {
  const execute = (token: string, body: string) =>
    fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": token,
      },
      body,
    });

  return {
    graphql: async (query, options) => {
      const body = JSON.stringify({
        query,
        variables: options?.variables ?? {},
      });

      const token = await getValidAccessToken(shop);
      const response = await execute(token, body);

      if (response.status !== 401) {
        return response;
      }

      // The stored expiry can be stale (or absent) — a 401 means the token is
      // gone regardless of what the DB claims, so refresh and retry once.
      console.warn(
        `[shopify-admin] 401 for ${shop} — refreshing access token and retrying once`,
      );

      let refreshedToken: string | null = null;
      try {
        refreshedToken = await refreshAccessToken(shop);
      } catch (error) {
        console.error(
          `[shopify-admin] Token refresh after 401 failed for ${shop}:`,
          error,
        );
      }

      if (!refreshedToken) {
        return response;
      }

      return execute(refreshedToken, body);
    },
    usedStoredAccessToken: true,
  };
}

/**
 * Refreshes the shop's offline access token, sharing one request per shop.
 * Throws `SHOP_NEEDS_REINSTALL:<shop>` when no usable refresh token remains.
 */
async function refreshAccessToken(shop: string): Promise<string> {
  const existing = inFlightRefreshes.get(shop);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async () => {
    const session = await prisma.session.findUnique({
      where: { id: `offline_${shop}` },
      select: { refreshToken: true, refreshTokenExpires: true },
    });

    if (!session?.refreshToken) {
      throw new Error(
        `SHOP_NEEDS_REINSTALL:${shop} — no refresh token stored, the app must be reinstalled`,
      );
    }

    if (
      session.refreshTokenExpires &&
      new Date(session.refreshTokenExpires).getTime() <= Date.now()
    ) {
      throw new Error(
        `SHOP_NEEDS_REINSTALL:${shop} — refresh token expired on ${session.refreshTokenExpires.toISOString()}`,
      );
    }

    return refreshShopifyAccessToken(shop, session.refreshToken);
  })();

  inFlightRefreshes.set(shop, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(shop);
  }
}

async function refreshShopifyAccessToken(
  shop: string,
  refreshToken: string,
): Promise<string> {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Shopify API credentials for token refresh.");
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  const rawBody = await response.text();
  let data: ShopifyTokenRefreshResponse = {};
  try {
    data = rawBody ? (JSON.parse(rawBody) as ShopifyTokenRefreshResponse) : {};
  } catch {
    // Fall through to the error below with the raw body for context.
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to refresh Shopify access token for ${shop}: ${response.status} ${rawBody}`,
    );
  }

  const nextRefreshToken = data.refresh_token ?? refreshToken;
  const expires = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null;
  const refreshTokenExpires = data.refresh_token_expires_in
    ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
    : undefined;

  await prisma.session.update({
    where: { id: `offline_${shop}` },
    data: {
      accessToken: data.access_token,
      refreshToken: nextRefreshToken,
      expires,
      ...(refreshTokenExpires ? { refreshTokenExpires } : {}),
    },
  });

  await prisma.store
    .update({
      where: { shopDomain: shop },
      data: { accessToken: data.access_token },
    })
    .catch(() => {});

  console.log(
    `[shopify-admin] Refreshed access token for ${shop}, expires at ${expires?.toISOString() ?? "unknown"}`,
  );

  return data.access_token;
}

async function getValidAccessToken(shop: string): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
    select: { accessToken: true, refreshToken: true, expires: true },
  });

  if (!session?.accessToken) {
    const storeAccessToken = await getStoreAccessToken(shop);
    if (storeAccessToken) {
      console.warn(
        `[shopify-admin] No offline session for ${shop}, falling back to stored store.accessToken`,
      );
      return storeAccessToken;
    }

    throw new Error(`Could not find a session for shop ${shop}`);
  }

  const isExpired = session.expires
    ? new Date(session.expires).getTime() < Date.now() + TOKEN_EXPIRY_BUFFER_MS
    : false;

  if (!isExpired) {
    return session.accessToken;
  }

  if (!session.refreshToken) {
    console.error(
      `[shopify-admin] Access token for ${shop} is expired and no refresh token is stored — the app needs to be reinstalled`,
    );
    return session.accessToken;
  }

  try {
    return await refreshAccessToken(shop);
  } catch (error) {
    console.error(
      `[shopify-admin] Proactive token refresh failed for ${shop}:`,
      error,
    );
    // Return the stale token so the caller surfaces Shopify's own 401 instead
    // of failing with a different error here.
    return session.accessToken;
  }
}
