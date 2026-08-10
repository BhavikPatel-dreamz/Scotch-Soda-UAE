import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

type ShopifyTokenRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
};

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
  console.log(`[getAdminGraphqlClient] Starting for shop: ${shop}`);
  return createFallbackGraphqlClient(shop);
}

async function createFallbackGraphqlClient(
  shop: string,
): Promise<AdminGraphqlClient> {
  const session = await getValidatedSession(shop);

  return {
    graphql: async (query, options) => {
      const token = await getValidAccessToken(shop);
      console.log(
        `[createFallbackGraphqlClient] Executing GraphQL query for ${shop} using token: ${token.substring(0, 10)}...`,
      );
      const response = await fetch(
        `https://${shop}/admin/api/${apiVersion}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables ?? {},
          }),
        },
      );

      return response;
    },
    usedStoredAccessToken: true,
  };
}

async function getValidatedSession(shop: string) {
  console.log(`[getValidatedSession] Fetching session from DB for ${shop}`);
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
    select: {
      accessToken: true,
      refreshToken: true,
      expires: true,
    },
  });

  if (!session?.accessToken) {
    const storeAccessToken = await getStoreAccessToken(shop);
    if (storeAccessToken) {
      console.warn(
        `[getValidatedSession] No offline session found for ${shop}, using stored store.accessToken instead`,
      );
      return { accessToken: storeAccessToken, refreshToken: null };
    }

    console.error(`[getValidatedSession] No session found for ${shop}`);
    throw new Error(`Could not find a session for shop ${shop}`);
  }

  const testResponse = await fetch(
    `https://${shop}/admin/api/${apiVersion}/shop.json`,
    {
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
      },
    },
  );

  if (testResponse.status === 401) {
    if (session.refreshToken) {
      console.log(
        `[getValidatedSession] Token revoked but refresh token available, attempting refresh for ${shop}`,
      );
      const newToken = await refreshShopifyAccessToken(
        shop,
        session.refreshToken,
      );
      return { accessToken: newToken, refreshToken: session.refreshToken };
    }
    console.error(
      `[getValidatedSession] Stored token is revoked for ${shop}. App needs reinstallation.`,
    );
    await prisma.session
      .delete({ where: { id: `offline_${shop}` } })
      .catch(() => {});
    throw new Error(`SHOP_NEEDS_REINSTALL:${shop}`);
  }

  return session;
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
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const rawBody = await response.text();
  const data = rawBody
    ? (JSON.parse(rawBody) as ShopifyTokenRefreshResponse)
    : {};

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to refresh Shopify access token for ${shop}: ${response.status} ${rawBody}`,
    );
  }

  const nextRefreshToken = data.refresh_token ?? refreshToken;
  const expires = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null;

  await prisma.session.update({
    where: { id: `offline_${shop}` },
    data: {
      accessToken: data.access_token,
      refreshToken: nextRefreshToken,
      expires,
    },
  });

  await prisma.store
    .update({
      where: { shopDomain: shop },
      data: { accessToken: data.access_token },
    })
    .catch(() => {});

  return data.access_token;
}

async function getValidAccessToken(shop: string): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
    select: { accessToken: true, refreshToken: true, expires: true },
  });

  if (!session?.accessToken) {
    throw new Error(`Could not find a session for shop ${shop}`);
  }

  const now = Date.now();
  const isExpired = session.expires
    ? new Date(session.expires).getTime() < now + 5 * 60 * 1000
    : false;

  if (!isExpired) {
    return session.accessToken;
  }

  if (session.refreshToken) {
    try {
      const latest = await prisma.session.findUnique({
        where: { id: `offline_${shop}` },
        select: { accessToken: true, expires: true },
      });

      const stillExpired = latest?.expires
        ? new Date(latest.expires).getTime() < now + 2 * 60 * 1000
        : true;

      if (!stillExpired && latest?.accessToken) {
        return latest.accessToken;
      }
    } catch (refreshError) {
      console.warn(
        `[getValidAccessToken] Token expired for ${shop}, will need re-auth on next request`,
      );
    }
  }

  return session.accessToken;
}
