import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  getQIVOSToken,
  refreshQIVOSToken,
} from "../../utils/qivos-token.server";
import { CORS_HEADERS } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import { parseResponseBody } from "app/utils/qivos-utils.server";
import { sendQivosRequestWithRetry } from "app/utils/qivos-person-backfill.server";

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



export const action = async ({ request }: ActionFunctionArgs) => {

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
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
        ...CORS_HEADERS,
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
        ...CORS_HEADERS,
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
          ...CORS_HEADERS,
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
      ...CORS_HEADERS,
    },
  });
};