import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  getQIVOSToken,
  refreshQIVOSToken,
} from "../../utils/qivos-token.server";
import {
  ensureStoreRecord,
  resolveCurrentShop,
  toShopifyCustomerGid,
} from "../../utils/store.server";
import {
  CustomerIdentityMetafieldValues,
  getCustomerIdentityMetafields,
  saveCustomerIdentityMetafields,
  type CustomerMetafieldSyncResult,
  type CustomerSyncBody,
} from "../../utils/shopify-customer-metafields.server";
import {  CORS_HEADERS  } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import { normalizeActiveValue } from "app/utils/qivos-utils.server";

type LoyaltyMembershipStatusBody = {
  customerId?: string;
  personQCCode?: string;
  loyaltyQCCode?: string;
  active?: unknown;
  shop?: string;
  [key: string]: unknown;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {

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


  if (request.method !== "POST" && request.method !== "PUT") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body: LoyaltyMembershipStatusBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // ── Auth proxy ──────────────────────────────────────────────────────────
  let proxyContext:
    | Awaited<ReturnType<typeof authenticateApiProxyRequest>>
    | undefined;

  try {
    proxyContext = await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to authenticate app proxy request:", error);
  }

  const url = new URL(request.url);
  const shopFromQuery = url.searchParams.get("shop") ?? undefined;
  const customerIdFromQuery = url.searchParams.get("customerId") ?? undefined;

  const requestBody: LoyaltyMembershipStatusBody & CustomerSyncBody = {
    ...body,
    shop: body.shop ?? shopFromQuery ?? proxyContext?.shop,
    customerId:
      toShopifyCustomerGid(body.customerId) ??
      toShopifyCustomerGid(customerIdFromQuery) ??
      toShopifyCustomerGid(proxyContext?.customerId) ??
      undefined,
  };
  await ensureStoreRecord(request, requestBody as Record<string, unknown>);

  // ── Extract codes from pathname ─────────────────────────────────────────
  const pathMatch = url.pathname.match(
    /\/persons\/([^/]+)\/loyalty-membership\/([^/]+)\/status\/?$/,
  );

  const personQCCodeFromPath = pathMatch?.[1]?.trim() ?? undefined;
  const loyaltyQCCodeFromPath = pathMatch?.[2]?.trim() ?? undefined;

  const personQCCode =
    personQCCodeFromPath ||
    (typeof requestBody.personQCCode === "string"
      ? requestBody.personQCCode.trim()
      : "");
  const loyaltyQCCode =
    loyaltyQCCodeFromPath ||
    (typeof requestBody.loyaltyQCCode === "string"
      ? requestBody.loyaltyQCCode.trim()
      : "");
  const active = normalizeActiveValue(requestBody.active);

  if (!personQCCode || !loyaltyQCCode || active === null) {
    return new Response(
      JSON.stringify({
        error:
          "personQCCode, loyaltyQCCode, and active (true/false) are required",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  // ── QIVOS status update — always fires ──────────────────────────────────
const thirdPartyUrl =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons/${encodeURIComponent(
    personQCCode,
  )}/loyalty-membership/${encodeURIComponent(
    loyaltyQCCode,
  )}/status`;

const qivosBody = JSON.stringify({
  active: {
    value: String(active), // "true" | "false"
  },
});

async function sendStatusUpdate(token: string) {
  return fetch(thirdPartyUrl, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-jwt-token": token,
    },
    body: qivosBody,
  });
}

let thirdPartyResponse: Response;

try {
  const token = await getQIVOSToken();

  thirdPartyResponse = await sendStatusUpdate(token);

  if (thirdPartyResponse.status === 401) {
    console.warn(
      "QIVOS loyalty status update returned 401; refreshing token and retrying.",
    );

    const refreshedToken = await refreshQIVOSToken();

    thirdPartyResponse = await sendStatusUpdate(refreshedToken);
  }
} catch (error) {
  console.error(
    "Failed to complete QIVOS loyalty status update:",
    error,
  );

  return new Response(
    JSON.stringify({
      error: "Failed to complete QIVOS loyalty status update",
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

  // ── Parse QIVOS response ────────────────────────────────────────────────
  const text = await thirdPartyResponse.text();
  let responseData: unknown;
  try {
    responseData = JSON.parse(text);
  } catch {
    responseData = text ? { raw: text } : null;
  }

  // ── Metafield sync — only save missing values from path params ──────────
  let customerMetafieldSync: CustomerMetafieldSyncResult | undefined;

  const resolvedShop = await resolveCurrentShop(request, requestBody);
  const resolvedCustomerId =
    typeof requestBody.customerId === "string" && requestBody.customerId.trim()
      ? requestBody.customerId.trim()
      : undefined;

  if (resolvedShop && resolvedCustomerId) {
    try {
      const namespace = requestBody.metafieldNamespace || "custom";

      const resolvedGid = toShopifyCustomerGid(resolvedCustomerId);
      if (!resolvedGid) {
        throw new Error(
          `Could not resolve Shopify GID for customerId: ${resolvedCustomerId}`,
        );
      }

      const existingMetafields = await getCustomerIdentityMetafields({
        shop: resolvedShop,
        customerId: resolvedGid,
        namespace,
      });


      // Step 2: Only keep values that are missing in metafields
      const valuesToSave: CustomerIdentityMetafieldValues = {
        personQCCode: existingMetafields.personQCCode
          ? undefined // already exists → skip
          : personQCCodeFromPath, // missing → save path value
        loyaltyQCCode: existingMetafields.loyaltyQCCode
          ? undefined // already exists → skip
          : loyaltyQCCodeFromPath, // missing → save path value
        // phone intentionally not touched here
      };

      const hasAnythingToSave =
        valuesToSave.personQCCode || valuesToSave.loyaltyQCCode;

      if (!hasAnythingToSave) {
        // Both already exist — no metafield write needed
        console.log(
          "[loyaltyStatus] Both metafields already exist — skipping metafield write.",
          { customerId: resolvedCustomerId, existingMetafields },
        );

        customerMetafieldSync = {
          synced: false,
          shop: resolvedShop,
          customerId: resolvedCustomerId,
          skippedReason:
            "personQCCode and loyaltyQCCode already present in metafields",
          savedValues: existingMetafields,
        };
      } else {
        const saveResult = await saveCustomerIdentityMetafields({
          shop: resolvedShop,
          customerId: resolvedCustomerId,
          namespace,
          values: valuesToSave,
        });

        customerMetafieldSync = {
          synced: true,
          shop: resolvedShop,
          customerId: resolvedCustomerId,
          addedKeys: saveResult.addedKeys,
          skippedReason: saveResult.skippedReason,
          shopAuthenticated: saveResult.shopAuthenticated,
          savedValues: saveResult.savedValues,
        };

        console.log(
          "[loyaltyStatus] Metafield save result:",
          customerMetafieldSync,
        );
      }
    } catch (error) {
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error instanceof Response) {
        errorMessage = `HTTP ${error.status}: ${error.statusText || "unexpected response"}`;
      } else {
        errorMessage = String(error) || "metafield sync failed unexpectedly";
      }

      const isMissingSessionError = errorMessage.includes(
        "Could not find a session for shop",
      );

      customerMetafieldSync = {
        synced: false,
        shop: resolvedShop,
        customerId: resolvedCustomerId,
        shopAuthenticated: isMissingSessionError ? false : undefined,
        skippedReason: errorMessage,
      };
    }
  } else {
    console.log(
      "[loyaltyStatus] shop or customerId missing — skipping metafield sync.",
      { resolvedShop, resolvedCustomerId },
    );
  }

  // ── Build final response ────────────────────────────────────────────────
  const finalResponse =
    customerMetafieldSync === undefined
      ? responseData
      : {
          ...(responseData && typeof responseData === "object"
            ? (responseData as Record<string, unknown>)
            : { data: responseData }),
          customerMetafieldSync,
        };

  return new Response(JSON.stringify(finalResponse), {
    status: thirdPartyResponse.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
};
