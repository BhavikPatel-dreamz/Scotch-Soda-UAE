import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  getQIVOSToken,
  refreshQIVOSToken,
} from "../../utils/qivos-token.server";
import {
  syncCustomerMetafields,
  type CustomerMetafieldSyncResult,
  type CustomerSyncBody,
} from "../../utils/shopify-customer-metafields.server";
import {
  ensureStoreRecord,
  resolveCurrentShop,
  toShopifyCustomerGid,
} from "../../utils/store.server";
import { getCorsHeaders } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import {
  isQivosLogicalFailure,
  extractStringValue,
  extractObjectRecord,
  findFirstNestedValue,
} from "../../utils/qivos-utils.server";

const QIVOS_PERSONS_URL = `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons`;
const QIVOS_PERSON_DETAILS_BASE_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/protected/persons`;

type PersonCreateBody = CustomerSyncBody & {
  consentList?: unknown[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: corsHeaders,
  });
};

function validatePersonPayload(body: PersonCreateBody): string | null {
  if (!Array.isArray(body.telephoneList) || body.telephoneList.length === 0) {
    return "telephoneList is required";
  }

  return null;
}

function buildQivosRequestBody(body: PersonCreateBody) {
  const qivosBody = { ...body };
  delete qivosBody.customerId;
  delete qivosBody.shop;
  delete qivosBody.metafieldNamespace;
  delete qivosBody.countryCode;
  delete qivosBody.email;
  delete qivosBody.phone;
  delete qivosBody.loyaltySync;
  return qivosBody;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : null;
  }
}

async function sendQivosRequestWithRetry(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  async function execute(requestToken: string) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("x-jwt-token", requestToken);

    if (init.body !== undefined && init.body !== null && init.body !== "") {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url, {
      ...init,
      headers,
    });
  }

  let response = await execute(token);

  if (response.status === 401) {
    const refreshedToken = await refreshQIVOSToken();
    response = await execute(refreshedToken);
  }

  return response;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let body: PersonCreateBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
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
      throw error;
    }

    console.error("Failed to authenticate app proxy request:", error);
  }
  const url = new URL(request.url);
  const shopFromQuery = url.searchParams.get("shop") ?? undefined;
  const customerIdFromQuery = url.searchParams.get("customerId") ?? undefined;
  let customerId=
      body.customerId ??
      customerIdFromQuery ??
      proxyContext?.customerId ??
      undefined;
      const rawCustomerIdStr = customerId != null ? String(customerId) : undefined;

  
  const requestBody: PersonCreateBody = {
    ...body,
    shop: body.shop ?? shopFromQuery ?? proxyContext?.shop,
    customerId : toShopifyCustomerGid(rawCustomerIdStr)
  };

  await ensureStoreRecord(request, requestBody as Record<string, unknown>);

  const validationError = validatePersonPayload(requestBody);
  if (validationError) {
    return new Response(JSON.stringify({ error: validationError }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  let token: string;
  try {
    token = await getQIVOSToken();
  } catch (error) {
    console.error("Failed to obtain QIVOS token for person creation:", error);
    return new Response(
      JSON.stringify({ error: "Failed to obtain QIVOS token" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }

  const qivosBody = buildQivosRequestBody(requestBody);
  console.log("[persons.create] Forwarding payload to QIVOS", {
    hasTelephoneList: Array.isArray(qivosBody.telephoneList),
    hasEmailList: Array.isArray(qivosBody.emailList),
    hasLoyaltyMembershipData: Array.isArray(qivosBody.loyaltyMembershipData),
    hasConsentList: Array.isArray(qivosBody.consentList),
    customerId: requestBody.customerId,
    shop: requestBody.shop,
    payload: JSON.stringify(qivosBody), // Log full payload for debugging
  });

  const thirdPartyResponse = await sendQivosRequestWithRetry(
    QIVOS_PERSONS_URL,
    {
      method: "POST",
      body: JSON.stringify(qivosBody),
    },
    token,
  );

  let responseData: unknown = await parseResponseBody(thirdPartyResponse);
  
  if (!thirdPartyResponse.ok || isQivosLogicalFailure(responseData)) {
    console.error("[persons.create] QIVOS creation failed", {
      status: thirdPartyResponse.status,
      responseData: JSON.stringify(responseData),
    });
  }

  let customerSyncSource: unknown = responseData;

  if (thirdPartyResponse.ok && !isQivosLogicalFailure(responseData)) {
    const personQCCode =
      findFirstNestedValue(responseData, [
        "personQCCode",
        "QCCode",
        "personCode",
        "personId",
        "personID",
      ]) ?? extractStringValue((qivosBody as Record<string, unknown>).QCCode);

    if (personQCCode) {
      const personDetailsUrl = `${QIVOS_PERSON_DETAILS_BASE_URL}/${encodeURIComponent(personQCCode)}`;

      try {
        const personDetailsResponse = await sendQivosRequestWithRetry(
          personDetailsUrl,
          { method: "GET" },
          token,
        );

        if (personDetailsResponse.ok) {
          customerSyncSource = await parseResponseBody(personDetailsResponse);
        } else {
          // ✅ Log body for debugging
          const errBody = await parseResponseBody(personDetailsResponse).catch(
            () => null,
          );

          // Add this to see the actual message
          const messages = (errBody as any)?.messages;
          console.log(
            "QIVOS person details fetch failed after create; falling back to create response.",
            {
              personQCCode,
              status: personDetailsResponse.status,
              messages: JSON.stringify(messages), // ← this will show actual error
            },
          );
          // customerSyncSource stays as responseData (create response)
        }
      } catch (error) {
        console.warn(
          "QIVOS person details fetch threw after create; falling back to create response.",
          {
            personQCCode,
            error,
          },
        );
      }
    }
  }

  let customerMetafieldSync: CustomerMetafieldSyncResult | undefined;

  if (thirdPartyResponse.ok) {
    try {
      customerMetafieldSync = await syncCustomerMetafields(
        request,
        { ...requestBody, loyaltySync: true },
        customerSyncSource,
      );
      console.log("[persons.create] customerMetafieldSync", customerMetafieldSync);
    } catch (error) {
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error instanceof Response) {
        errorMessage = `HTTP ${error.status}: ${error.statusText || "unexpected response"}`;
      } else {
        errorMessage = String(error) || "metafield sync failed unexpectedly";
      }

      const shop = await resolveCurrentShop(request, requestBody);
      const isMissingSessionError = errorMessage.includes(
        "Could not find a session for shop",
      );

      customerMetafieldSync = {
        synced: false,
        shop: shop ?? undefined,
        shopAuthenticated: isMissingSessionError ? false : undefined,
        skippedReason: errorMessage,
      };
    }
  }

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
};
