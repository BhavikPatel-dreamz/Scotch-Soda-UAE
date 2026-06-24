import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import { CORS_HEADERS } from "../../utils/cors.server";
import {
  creditCustomerStoreCredit,
  getStoreCreditPermissionError,
} from "../../utils/customer-credit.server";
import {
  ensureStoreRecord,
  resolveCurrentShop,
  toShopifyCustomerGid,
} from "../../utils/store.server";
import { toPositiveNumber } from "app/utils/order-sync.server";

type CustomerCreditBody = {
  shop?: string;
  customerId?: string;
  redeemPoints?: number | string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // const corsHeaders = getCorsHeaders(request.headers.get("Origin"), "POST, OPTIONS");

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: CORS_HEADERS,
  });
};


export const action = async ({ request }: ActionFunctionArgs) => {
  // const corsHeaders = getCorsHeaders(request.headers.get("Origin"), "POST, OPTIONS");

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  let body: CustomerCreditBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  let proxyContext:
    | Awaited<ReturnType<typeof authenticateApiProxyRequest>>
    | undefined;

  try {
    proxyContext = await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) {
      const errorBody = await error.text();
      return new Response(errorBody, {
        status: error.status,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    console.error("Failed to authenticate app proxy request:", error);
  }

  await ensureStoreRecord(request, body as Record<string, unknown>);

  const shop = body.shop ?? proxyContext?.shop ?? (await resolveCurrentShop(request, body as Record<string, unknown>));
  const customerId = body.customerId?.trim();
  const customerGid = toShopifyCustomerGid(customerId);
  const redeemPoints = toPositiveNumber(body.redeemPoints);

  if (!shop || !customerGid || redeemPoints === null) {
    return new Response(
      JSON.stringify({
        error: "shop, customerId, and redeemPoints are required",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      },
    );
  }

  try {
    const result = await creditCustomerStoreCredit({
      shop,
      customerId: customerGid,
      redeemPoints,
    });

    return new Response(
      JSON.stringify(result),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      },
    );
  } catch (error) {
    console.error("STORE CREDIT ERROR:", error);

    const permissionError = getStoreCreditPermissionError(error);
    if (permissionError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: permissionError,
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      },
    );
  }
};
