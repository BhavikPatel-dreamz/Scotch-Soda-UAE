import prisma from "../db.server";
import { unauthenticated, apiVersion } from "../shopify.server";

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
  usedStoredAccessToken?: boolean;
};

export async function getAdminGraphqlClient(shop: string): Promise<AdminGraphqlClient> {
  console.log(`[getAdminGraphqlClient] Starting for shop: ${shop}`);
  
  try {
    const { admin, session } = await unauthenticated.admin(shop);
    
    const now = Date.now();
   const isExpired = session?.expires 
  ? new Date(session.expires).getTime() < now + 5 * 60 * 1000
  : false;

    if (!isExpired) {
      console.log(`[getAdminGraphqlClient] Library session is valid for ${shop}`);
      return {
        graphql: (query, options) => {
          console.log(`[getAdminGraphqlClient] Executing library GraphQL query for ${shop}`);
          return admin.graphql(query, options);
        },
        usedStoredAccessToken: false,
      };
    } else {
      console.log(`[getAdminGraphqlClient] Library session is expired for ${shop}, entering fallback mode to refresh`);
    }
  } catch (error) {
    console.log(`[getAdminGraphqlClient] unauthenticated.admin failed for ${shop}, entering fallback mode`);
    if (error instanceof Response) {
      const body = await error.text().catch(() => "no body");
      console.warn(`[getAdminGraphqlClient] unauthenticated.admin Response ${error.status}: ${body}`);
    } else {
      console.warn(`[getAdminGraphqlClient] unauthenticated.admin error:`, JSON.stringify(error, null, 2));
    }
  }

  console.log(`[getAdminGraphqlClient] Fetching session from DB for ${shop}`);
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
    select: { 
      accessToken: true,
      refreshToken: true, 
      expires: true,
    },
  });

  if (!session?.accessToken) {
    console.error(`[getAdminGraphqlClient] No session found for ${shop}`);
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
  console.error(`[getAdminGraphqlClient] Stored token is revoked for ${shop}. App needs reinstallation.`);
 
  await prisma.session.delete({ where: { id: `offline_${shop}` } }).catch(() => {});
  throw new Error(`SHOP_NEEDS_REINSTALL:${shop}`);
}

  let accessToken = session.accessToken;
  const now = Date.now();
  const expiryTime = session.expires ? new Date(session.expires).getTime() : 0;
  const isExpired = session.expires 
    ? expiryTime < now + 5 * 60 * 1000
    : false;

  if (isExpired && session.refreshToken) {
    try {
      console.log(`[getAdminGraphqlClient] Attempting to refresh token for ${shop}`);
      // Re-fetch to check if already refreshed by another request
      const latest = await prisma.session.findUnique({
        where: { id: `offline_${shop}` },
        select: { accessToken: true, expires: true }
      });
      
      const stillExpired = latest?.expires 
        ? new Date(latest.expires).getTime() < now + 2 * 60 * 1000
        : true;

      if (!stillExpired && latest?.accessToken) {
        console.log(`[getAdminGraphqlClient] Token already refreshed by another process for ${shop}`);
        accessToken = latest.accessToken;
      } else {
        accessToken = await refreshShopifyAccessToken(shop, session.refreshToken);
        console.log(`[getAdminGraphqlClient] Token refreshed successfully for ${shop}`);
      }
    } catch (refreshError) {
      console.warn(`[getAdminGraphqlClient] Manual refresh failed for ${shop}:`, refreshError);
    }
  }

  return {
    graphql: async (query, options) => {
      console.log(`[getAdminGraphqlClient] Executing fallback GraphQL query for ${shop} using token: ${accessToken.substring(0, 10)}...`);
      const response = await fetch(
        `https://${shop}/admin/api/${apiVersion}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables ?? {},
          }),
        }
      );
      
      if (response.status === 401) {
          console.warn(`[getAdminGraphqlClient] Fallback query returned 401 Unauthorized for ${shop}`);
      }
      
      return response;
    },
    usedStoredAccessToken: true,
  };
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
