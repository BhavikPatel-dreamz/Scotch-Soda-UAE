import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
  usedStoredAccessToken?: boolean;
};

export async function getAdminGraphqlClient(shop: string): Promise<AdminGraphqlClient> {
  console.log(`[getAdminGraphqlClient] Starting for shop: ${shop}`);
  return createFallbackGraphqlClient(shop);
}

async function createFallbackGraphqlClient(shop: string): Promise<AdminGraphqlClient> {
  const session = await getValidatedSession(shop);

  return {
    graphql: async (query, options) => {
      const token = await getValidAccessToken(shop);
      console.log(`[createFallbackGraphqlClient] Executing GraphQL query for ${shop} using token: ${token.substring(0, 10)}...`);
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
        }
      );

      if (response.status === 401) {
        console.warn(`[createFallbackGraphqlClient] Token returned 401 for ${shop}, attempting refresh`);
        const freshSession = await getValidatedSession(shop);
        if (freshSession.accessToken !== token) {
          const retryResponse = await fetch(
            `https://${shop}/admin/api/${apiVersion}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-Shopify-Access-Token": freshSession.accessToken,
              },
              body: JSON.stringify({
                query,
                variables: options?.variables ?? {},
              }),
            }
          );
          return retryResponse;
        }
      }

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
    console.error(`[getValidatedSession] No session found for ${shop}`);
    throw new Error(`Could not find a session for shop ${shop}`);
  }

  const testResponse = await fetch(
    `https://${shop}/admin/api/${apiVersion}/shop.json`,
    {
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
      },
    }
  );

  if (testResponse.status === 401) {
    if (session.refreshToken) {
      console.log(`[getValidatedSession] Token revoked but refresh token available, attempting refresh for ${shop}`);
      const newToken = await refreshShopifyAccessToken(shop, session.refreshToken);
      return { accessToken: newToken, refreshToken: session.refreshToken };
    }
    console.error(`[getValidatedSession] Stored token is revoked for ${shop}. App needs reinstallation.`);
    await prisma.session.delete({ where: { id: `offline_${shop}` } }).catch(() => {});
    throw new Error(`SHOP_NEEDS_REINSTALL:${shop}`);
  }

  return session;
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

      return await refreshShopifyAccessToken(shop, session.refreshToken);
    } catch (refreshError) {
      console.warn(`[getValidAccessToken] Refresh failed for ${shop}:`, refreshError);
    }
  }

  return session.accessToken;
}

async function refreshShopifyAccessToken(shop: string, refreshToken: string): Promise<string> {
  console.log(`[refreshShopifyAccessToken] Requesting new token for ${shop}`);
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[refreshShopifyAccessToken] Failed for ${shop}: ${response.status} ${body}`);
    throw new Error(`Shopify token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  console.log(`[refreshShopifyAccessToken] Successfully got new token for ${shop}. Expires in: ${data.expires_in}s`);

  await prisma.session.update({
    where: { id: `offline_${shop}` },
    data: {
      accessToken: data.access_token,
      expires: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    },
  });

  await prisma.store.update({
    where: { shopDomain: shop },
    data: { accessToken: data.access_token },
  });

  return data.access_token;
}
