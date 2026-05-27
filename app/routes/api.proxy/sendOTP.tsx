import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getQIVOSToken } from "../../utils/qivos-token.server";
import { ensureStoreRecord } from "../../utils/store.server";
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
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  await ensureStoreRecord(request, body);

  
  const mobileNumber =
    typeof body.mobileNumber === "string" ? body.mobileNumber : undefined;
  const countryCode =
    typeof body.countryCode === "string" ? body.countryCode : undefined;
  const otpProfileCode =
    typeof body.otpProfileCode === "string" ? body.otpProfileCode : "ECOMM_OTP";
  const type = typeof body.type === "string" ? body.type : "OTP_BASIC";
  const languageCode =
    typeof body.languageCode === "string" ? body.languageCode : "en";

  if (!mobileNumber || !countryCode) {
    return new Response(
      JSON.stringify({ error: "mobileNumber and countryCode are required" }),
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

  const thirdPartyResponse = await fetch(
    `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/otp/request`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-jwt-token": token,
      },
      body: JSON.stringify({
        mobileNumber,
        countryCode,
        otpProfileCode,
        type,
        languageCode,
      }),
    },
  );

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
