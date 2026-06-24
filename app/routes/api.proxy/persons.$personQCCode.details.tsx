import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  syncCustomerMetafields,
  type CustomerMetafieldSyncResult,
  type CustomerSyncBody,
} from "../../utils/shopify-customer-metafields.server";
import { ensureStoreRecord, toShopifyCustomerGid } from "../../utils/store.server";
import { CORS_HEADERS } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import {
  extractStringValue,
  extractObjectRecord,
  findFirstNestedValue,
  normalizeBooleanValue,
  extractQivosPayload,
  isQivosLogicalFailure,
  parseResponseBody,
  sendQivosRequest,
} from "../../utils/qivos-utils.server";

const QIVOS_PERSON_DETAILS_BASE_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons`;
type PersonDetailsBody = CustomerSyncBody & {
  personQCCode?: string;
  emailAddress?: string;
  isPrimary?: unknown;
  attributes?: unknown;
};

function extractEmailFromBody(body: PersonDetailsBody): string | undefined {
  const directEmail =
    extractStringValue(body.email) ?? extractStringValue(body.emailAddress);
  if (directEmail) {
    return directEmail;
  }

  if (!Array.isArray(body.emailList)) {
    return undefined;
  }

  for (const item of body.emailList) {
    const record = extractObjectRecord(item);
    const email = record
      ? (extractStringValue(record.emailAddress) ??
        extractStringValue(record.email))
      : undefined;
    if (email) {
      return email;
    }
  }

  return undefined;
}

function extractAttributes(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attributes = value
    .map((item) => extractObjectRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

  return attributes.length > 0 ? attributes : undefined;
}

function buildEmailPatchPayload(
  body: PersonDetailsBody,
  emailAddress: string,
): Record<string, unknown> {
  if (Array.isArray(body.emailList)) {
    for (const item of body.emailList) {
      const record = extractObjectRecord(item);
      if (record) {
        const payload: Record<string, unknown> = {
          emailAddress:
            extractStringValue(record.emailAddress) ??
            extractStringValue(record.email) ??
            emailAddress,
        };

        const isPrimary =
          normalizeBooleanValue(record.isPrimary) ??
          normalizeBooleanValue(body.isPrimary);
        if (typeof isPrimary === "boolean") {
          payload.isPrimary = isPrimary;
        }

        const attributes =
          extractAttributes(record.attributes) ??
          extractAttributes(body.attributes);
        if (attributes) {
          payload.attributes = attributes;
        }

        return payload;
      }
    }
  }

  const payload: Record<string, unknown> = { emailAddress };
  const isPrimary = normalizeBooleanValue(body.isPrimary);
  if (typeof isPrimary === "boolean") {
    payload.isPrimary = isPrimary;
  } else {
    payload.isPrimary = true;
  }

  const attributes = extractAttributes(body.attributes);
  if (attributes) {
    payload.attributes = attributes;
  }

  return payload;
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}



export const loader = async ({ request }: LoaderFunctionArgs) => {
  // const corsHeaders = getCorsHeaders(request.headers.get("Origin"), "PUT, OPTIONS");

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

export const action = async ({ request, params }: ActionFunctionArgs) => {
  // const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body: PersonDetailsBody;
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
      throw error;
    }

    console.error("Failed to authenticate app proxy request:", error);
  }

const rawCustomerId = body.customerId ?? proxyContext?.customerId ?? undefined;
const rawCustomerIdStr = rawCustomerId != null ? String(rawCustomerId) : undefined;

const requestBody: PersonDetailsBody = {
  ...body,
  personQCCode: body.personQCCode ?? params.personQCCode,
  shop: body.shop ?? proxyContext?.shop,
  customerId: toShopifyCustomerGid(rawCustomerIdStr),
};
  await ensureStoreRecord(request, requestBody);

  const personQCCode = extractStringValue(requestBody.personQCCode);
  if (!personQCCode) {
    return new Response(JSON.stringify({ error: "personQCCode is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  const requestedFirstName = extractStringValue(requestBody.firstName);
  const requestedLastName = extractStringValue(requestBody.lastName);
  const requestedEmail = extractEmailFromBody(requestBody);

  if (requestBody.emailList && !requestedEmail) {
    return new Response(
      JSON.stringify({ error: "emailList must include a valid emailAddress" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      },
    );
  }

  const shouldSkipPersonFetch =
    Boolean(requestedEmail) && !requestedFirstName && !requestedLastName;

  const personUrl = `${QIVOS_PERSON_DETAILS_BASE_URL}/${encodeURIComponent(personQCCode)}`;
  const personEmailUrl = `${QIVOS_PERSON_DETAILS_BASE_URL}/${encodeURIComponent(personQCCode)}/email`;
  let personResponseData: unknown = null;
  let qivosPerson: Record<string, unknown> | undefined;
  let verifiedPersonQCCode = personQCCode;
  let existingFirstName: string | undefined;
  let existingLastName: string | undefined;

  async function refreshPersonDetailsForSync() {
    const MAX_RETRIES = 2;

    // Build extended-response URL from personUrl
    // e.g. .../protected/persons/{id}  →  .../persons/{id}/extended-response
    const extendedPersonUrl =
      personUrl.replace("/protected/persons/", "/persons/") +
      "/extended-response";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const personResponse = await sendQivosRequest(extendedPersonUrl, {
          method: "GET",
        });
        const refreshedData = await parseResponseBody(personResponse);
        if (!personResponse.ok) {
          if (attempt < MAX_RETRIES && personResponse.status >= 500) {
            console.warn(
              `[QIVOS] Person refresh attempt ${attempt} failed with ${personResponse.status}, retrying...`,
            );
            await new Promise((r) => setTimeout(r, 500 * attempt));
            continue;
          }
          console.warn(
            `[QIVOS] Person refresh failed for ${verifiedPersonQCCode}`,
            {
              status: personResponse.status,
              response: refreshedData,
            },
          );
          return;
        }

        if (isQivosLogicalFailure(refreshedData)) {
          console.warn(
            `[QIVOS] Person refresh returned success:false`,
            refreshedData,
          );
          return;
        }

        personResponseData = refreshedData;
        qivosPerson = extractQivosPayload(refreshedData);
        verifiedPersonQCCode =
          extractStringValue(qivosPerson?.QCCode) ?? verifiedPersonQCCode;
        return; // success
      } catch (error) {
        if (attempt < MAX_RETRIES) continue;
        console.warn(
          `[QIVOS] Person refresh threw for ${verifiedPersonQCCode}`,
          error,
        );
      }
    }
  }

  if (!shouldSkipPersonFetch) {
    let personResponse: Response;

    try {
      personResponse = await sendQivosRequest(personUrl, {
        method: "GET",
      });
    } catch (error) {
      console.error("Failed to fetch QIVOS person details:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch QIVOS person details" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        },
      );
    }

    personResponseData = await parseResponseBody(personResponse);

    if (!personResponse.ok) {
      return new Response(JSON.stringify(personResponseData), {
        status: personResponse.status,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    if (isQivosLogicalFailure(personResponseData)) {
      console.error(
        "QIVOS returned success:false for person fetch:",
        personResponseData,
      );
      return new Response(JSON.stringify(personResponseData), {
        status: 422,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    qivosPerson = extractQivosPayload(personResponseData);
    verifiedPersonQCCode =
      extractStringValue(qivosPerson?.QCCode) ?? personQCCode;

    if (verifiedPersonQCCode !== personQCCode) {
      console.log(
        `[QIVOS] personQCCode mismatch — URL param: ${personQCCode}, QIVOS record: ${verifiedPersonQCCode}`,
      );
    }

    existingFirstName = findFirstNestedValue(qivosPerson, [
      "firstName",
      "givenName",
    ]);
    existingLastName = findFirstNestedValue(qivosPerson, [
      "lastName"
    ]);
  } else {
    console.log(
      `[QIVOS] Skipping person details fetch for email-only update on ${personQCCode}`,
    );
  }

 const namePatch: Record<string, unknown> = {};
if (requestedFirstName) {
  namePatch.firstName = { value: requestedFirstName };
}
if (requestedLastName) {
  namePatch.lastName = { value: requestedLastName };
}

  let namePatchResponseData: unknown;
  if (Object.keys(namePatch).length > 0) {
    try {
      const nameResponse = await sendQivosRequest(personUrl, {
        method: "PUT",
        body: JSON.stringify(namePatch),
      });
      namePatchResponseData = await parseResponseBody(nameResponse);

      // FIX 3 (same pattern): also guard name patch against logical failures.
      if (!nameResponse.ok) {
        return new Response(JSON.stringify(namePatchResponseData), {
          status: nameResponse.status,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        });
      }

      if (isQivosLogicalFailure(namePatchResponseData)) {
        console.error(
          "QIVOS returned success:false for name patch:",
          namePatchResponseData,
        );
        return new Response(JSON.stringify(namePatchResponseData), {
          status: 422,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        });
      }
    } catch (error) {
      console.error("Failed to patch missing QIVOS name:", error);
      return new Response(
        JSON.stringify({ error: "Failed to patch missing QIVOS name" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        },
      );
    }
  }

  let emailPatchResponseData: unknown;
  if (requestedEmail) {
    const emailPayload = buildEmailPatchPayload(requestBody, requestedEmail);

    try {
      const emailResponse = await sendQivosRequest(personEmailUrl, {
        method: "PUT",
        body: JSON.stringify(emailPayload),
      });
      emailPatchResponseData = await parseResponseBody(emailResponse);

      // FIX 3 (same pattern): also guard email patch against logical failures.
      if (!emailResponse.ok) {
        console.error("QIVOS email patch HTTP failure:", {
          personQCCode: verifiedPersonQCCode,
          url: personEmailUrl,
          payload: emailPayload,
          response: emailPatchResponseData,
          status: emailResponse.status,
        });

        return jsonResponse(
          {
            qivosError: emailPatchResponseData,
            qivosEmailRequest: {
              personQCCode: verifiedPersonQCCode,
              url: personEmailUrl,
              method: "PUT",
              payload: emailPayload,
            },
          },
          emailResponse.status,
          CORS_HEADERS,
        );
      }

      if (isQivosLogicalFailure(emailPatchResponseData)) {
        console.error("QIVOS returned success:false for email patch:", {
          personQCCode: verifiedPersonQCCode,
          url: personEmailUrl,
          payload: emailPayload,
          response: emailPatchResponseData,
        });

        return jsonResponse(
          {
            qivosError: emailPatchResponseData,
            qivosEmailRequest: {
              personQCCode: verifiedPersonQCCode,
              url: personEmailUrl,
              method: "PUT",
              payload: emailPayload,
            },
          },
          422,
          CORS_HEADERS,
        );
      }
    } catch (error) {
      console.error("Failed to patch missing QIVOS email:", error);
      return jsonResponse(
        {
          error: "Failed to patch missing QIVOS email",
          details: error instanceof Error ? error.message : String(error),
          qivosEmailRequest: {
            personQCCode: verifiedPersonQCCode,
            url: personEmailUrl,
            method: "PUT",
            payload: emailPayload,
          },
        },
        500,
        CORS_HEADERS,
      );
    }
  }

  if (shouldSkipPersonFetch && requestedEmail) {
    console.log(
      "Skipping person fetch and refreshing details.",
      shouldSkipPersonFetch,
      requestedEmail,
    );
    await refreshPersonDetailsForSync();
  }

  const metafieldSource =
    personResponseData && typeof personResponseData === "object"
      ? {
          ...(personResponseData as Record<string, unknown>),
          personQCCode: verifiedPersonQCCode,
          qivosPerson,
          customerId: requestBody.customerId,
        }
      : {
          ...(qivosPerson ?? {}),
          personQCCode: verifiedPersonQCCode,
          customerId: requestBody.customerId
        };

  let customerMetafieldSync: CustomerMetafieldSyncResult | undefined;
  try {
    customerMetafieldSync = await syncCustomerMetafields(
      request,
      requestBody,
      metafieldSource,
    );
  } catch (error) {
    console.error("Failed to sync Shopify customer metafields:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "metafield sync failed unexpectedly";

    customerMetafieldSync = {
      synced: false,
      shop: requestBody.shop,
      skippedReason: errorMessage,
    };
  }

  return new Response(
    JSON.stringify({
      success: true,
      personQCCode: verifiedPersonQCCode,
      qivosPerson: personResponseData,
      qivosNamePatched: Object.keys(namePatch).length > 0,
      qivosEmailPatched: Boolean(emailPatchResponseData),
      namePatchResponse: namePatchResponseData,
      emailPatchResponse: emailPatchResponseData,
      customerMetafieldSync,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    },
  );
};
