import { qivosApiCall } from "app/utils/qivos-api.server";
import { getQIVOSToken, refreshQIVOSToken } from "app/utils/qivos-token.server";
import type { LoaderFunction } from "react-router";


/**
 * Example route showing how to use QIVOS token in your API
 * 
 * Usage: GET /api/qivos-token-status
 */
export const loader: LoaderFunction = async ({ request }) => {
  // Only allow GET
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Get the action from query params
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Example 1: Get current token
    if (action === "get-token") {
      const token = await getQIVOSToken();
      return Response.json({
        success: true,
        token: token.substring(0, 20) + "...", // Don't expose full token in response
        timestamp: new Date().toISOString(),
      });
    }

    // Example 2: Force refresh token
    if (action === "refresh") {
      const newToken = await refreshQIVOSToken();
      return Response.json({
        success: true,
        message: "Token refreshed",
        newToken: newToken.substring(0, 20) + "...",
        timestamp: new Date().toISOString(),
      });
    }

    // Example 3: Check token status
    if (action === "status") {
      const token = await getQIVOSToken();
      return Response.json({
        success: true,
        tokenAvailable: !!token,
        timestamp: new Date().toISOString(),
      });
    }

    // Default: Show usage
    return Response.json({
      message: "QIVOS Token API Examples",
      usage: [
        "?action=get-token - Get current token (preview only)",
        "?action=refresh - Force token refresh",
        "?action=status - Check token availability",
      ],
    });
  } catch (error) {
    console.error("QIVOS token endpoint error:", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};

/**
 * Example POST endpoint using QIVOS API
 */
export const action = async ({ request }: { request: Request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json() as any;

    // Example: Call QIVOS API endpoint
    // Replace with your actual QIVOS endpoint
    const result = await qivosApiCall("/sso/v1/verify", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return Response.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("QIVOS API call failed:", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "QIVOS API call failed",
      },
      { status: 500 }
    );
  }
};
