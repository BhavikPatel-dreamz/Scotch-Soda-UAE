import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  getQIVOSToken,
  refreshQIVOSToken,
} from "../../utils/qivos-token.server";
import { getCorsHeaders } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";

const QIVOS_RESERVE_POINTS_URL = `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/pointlogs/reserve-points`;

type ReservePointsBody = {
  loyaltyMemberCode: string;
  orderNumber: string;
  pointsToReserve: number;
  reservationType: string;
  shop?: string;
  customerId?: string;
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

function validateReservePointsPayload(body: ReservePointsBody): string | null {
  if (!body.loyaltyMemberCode || typeof body.loyaltyMemberCode !== "string") {
    return "loyaltyMemberCode is required";
  }

  if (!body.orderNumber || typeof body.orderNumber !== "string") {
    return "orderNumber is required";
  }

  if (typeof body.pointsToReserve !== "number" || body.pointsToReserve <= 0) {
    return "pointsToReserve must be a positive number";
  }

  if (!body.reservationType || typeof body.reservationType !== "string") {
    return "reservationType is required";
  }

  return null;
}

function buildQivosRequestBody(body: ReservePointsBody) {
  return {
    loyaltyMemberCode: body.loyaltyMemberCode,
    orderNumber: body.orderNumber,
    pointsToReserve: body.pointsToReserve,
    reservationType: body.reservationType || "",
  };
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

  let body: ReservePointsBody;
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

  try {
    await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Failed to authenticate app proxy request:", error);
  }

  const validationError = validateReservePointsPayload(body);
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
    console.error(
      "Failed to obtain QIVOS token for reserve-points:",
      error,
    );
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

  const qivosBody = buildQivosRequestBody(body);


  const thirdPartyResponse = await sendQivosRequestWithRetry(
    QIVOS_RESERVE_POINTS_URL,
    {
      method: "POST",
      body: JSON.stringify(qivosBody),
    },
    token,
  );

  const responseData = await parseResponseBody(thirdPartyResponse);

  if (!thirdPartyResponse.ok) {
    console.error("[reserve-points] QIVOS request failed", {
      status: thirdPartyResponse.status,
      response: responseData,
    });
  }

  return new Response(JSON.stringify(responseData), {
    status: thirdPartyResponse.status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
};