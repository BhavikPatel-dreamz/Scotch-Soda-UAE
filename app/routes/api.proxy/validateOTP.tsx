import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ensureStoreRecord } from "../../utils/store.server";
import { getQIVOSToken } from "app/utils/qivos-token.server";
import { getCorsHeaders } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";

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

export const action = async ({ request }: ActionFunctionArgs) => {
  const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }

  await ensureStoreRecord(request, body);

  const url = new URL(request.url);
  const countryCode =
    (typeof body.countryCode === "string" ? body.countryCode : undefined) ??
    url.searchParams.get("countryCode") ??
    "in";
  const schemaCode =
    (typeof body.schemaCode === "string" ? body.schemaCode : undefined) ??
    url.searchParams.get("schemaCode") ??
    "0000";
  const mobileNumber =
    typeof body.mobileNumber === "string" ? body.mobileNumber : undefined;
  const oneTimePin =
    typeof body.oneTimePin === "string" ? body.oneTimePin : undefined;

  if (!mobileNumber || !oneTimePin) {
    return new Response(
      JSON.stringify({ error: "mobileNumber and oneTimePin are required" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }

   let token: string;
   try {
     token = await getQIVOSToken();
     console.log("Using JWT token from store: Present");
   } catch (err) {
     console.error("Failed to obtain QIVOS token:", err);
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

  const thirdPartyUrl = `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/otp/validate?countryCode=${encodeURIComponent(countryCode)}&schemaCode=${encodeURIComponent(schemaCode)}`;

  const thirdPartyResponse = await fetch(thirdPartyUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-jwt-token": token,
    },
    body: JSON.stringify({ mobileNumber, oneTimePin }),
  });

  const text = await thirdPartyResponse.text();
  let responseData: unknown;
  try {
    responseData = JSON.parse(text);
  } catch {
    responseData = { raw: text };
  }

  return new Response(JSON.stringify(responseData), {
    status: thirdPartyResponse.status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
};
