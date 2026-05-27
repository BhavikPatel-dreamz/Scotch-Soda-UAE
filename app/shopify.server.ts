import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session, admin }) => {
      console.log("[SHOPIFY] Authentication successful for shop:", session.shop);
      let shopName: string | null = null;
      let contactEmail: string | null = null;

      try {
        const response = await admin.graphql(
          `#graphql
            query StoreInstallDetails {
              shop {
                name
                contactEmail
              }
            }
          `,
        );

        const result = (await response.json()) as {
          data?: {
            shop?: {
              name?: string | null;
              contactEmail?: string | null;
            };
          };
        };

        shopName = result.data?.shop?.name ?? null;
        contactEmail = result.data?.shop?.contactEmail ?? null;
      } catch (error) {
        console.error("[SHOPIFY] Failed to fetch shop details after auth:", error);
      }

      await prisma.store.upsert({
        where: { shopDomain: session.shop },
        update: {
          shopName,
          contactEmail,
          accessToken: session.accessToken,
          scope: session.scope ?? null,
        },
        create: {
          shopDomain: session.shop,
          shopName,
          contactEmail,
          accessToken: session.accessToken,
          scope: session.scope ?? null,
        },
      });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
