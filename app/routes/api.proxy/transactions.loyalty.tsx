import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import {
  getQIVOSToken,
  refreshQIVOSToken,
} from "../../utils/qivos-token.server";
import { CORS_HEADERS } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";

const QIVOS_TRANSACTIONS_LOYALTY_URL = `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/transactions/loyalty`;

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

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : null;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body: any;
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

  // Authenticate the request if it's coming from Shopify App Proxy
  try {
    await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) {
      const status = error.status;
      const errorBody = await error.text();
      return new Response(errorBody, {
        status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      });
    }
    console.error("Failed to authenticate app proxy request:", error);
  }

  let token: string;
  try {
    token = await getQIVOSToken();
  } catch (error) {
    console.error("Failed to obtain QIVOS token for loyalty transaction:", error);
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

  const thirdPartyResponse = await sendQivosRequestWithRetry(
    QIVOS_TRANSACTIONS_LOYALTY_URL,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    token,
  );
  console.log()

  const responseData = await parseResponseBody(thirdPartyResponse);

  return new Response(JSON.stringify(responseData), {
    status: thirdPartyResponse.status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
};

