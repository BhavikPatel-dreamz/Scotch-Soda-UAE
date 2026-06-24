import prisma from "../db.server";
import { QIVOS_API_BASE_URL, QIVOS_USERNAME, QIVOS_ACCOUNT } from "./constants";

const QIVOS_LOGIN_URL = `${QIVOS_API_BASE_URL}/sso/v1/auth/login`;
const QIVOS_REFRESH_URL = `${QIVOS_API_BASE_URL}/sso/v1/auth/refresh`;
const QIVOS_PASSWORD = process.env.QIVOS_PASSWORD || "VW7Gha6Tckm89h7ZY!@#";

export interface QIVOSLoginResponse {
  data: {
    uid: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  iat: number;
  exp: number;
  aud: string[];
  iss: string;
}

/**
 * Initial login to get access token and refresh token
 */
async function loginQIVOS(): Promise<{
  token: string;
  refreshToken: string;
  expiresAt: Date;
  refreshTokenExpiresAt: Date;
}> {
  try {
    console.log("[QIVOS] Performing initial login...");
    console.log("[QIVOS] Login URL:", QIVOS_LOGIN_URL);
    console.log("[QIVOS] Username:", QIVOS_USERNAME);
    console.log("[QIVOS] Account:", QIVOS_ACCOUNT);

    const requestBody = {
      username: QIVOS_USERNAME,
      password: QIVOS_PASSWORD,
      account: QIVOS_ACCOUNT,
    };

    console.log("[QIVOS] Request body:", JSON.stringify(requestBody));
    console.log(
      "[QIVOS] QIVOS_PASSWORD env var set:",
      !!process.env.QIVOS_PASSWORD,
    );
    console.log("[QIVOS] Password length:", QIVOS_PASSWORD.length);
    console.log("[QIVOS] Password ends with:", QIVOS_PASSWORD.slice(-5));

    const response = await fetch(QIVOS_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://idp.ci-uat.net",
      },
      body: JSON.stringify(requestBody),
    });

    console.log("[QIVOS] Response status:", response.status);
    console.log(
      "[QIVOS] Response headers:",
      Object.fromEntries(response.headers),
    );

    const responseText = await response.text();
    console.log("[QIVOS] Response body:", responseText);

    // Parse response to check for API-level errors
    let responseData: any = {};
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.warn("[QIVOS] Could not parse response as JSON");
    }

    // Check for API errors in response body (even if status is 200)
    if (responseData.success === false) {
      const reason = responseData.payload?.REASON || "Unknown error";
      throw new Error(
        `QIVOS login failed: ${response.status} - ${reason} - ${responseText}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `QIVOS login error: ${response.status} ${response.statusText} - ${responseText}`,
      );
    }

    // Token is returned in the x-jwt-token header, refresh token in x-jwt-refresh-token
    const token = response.headers.get("x-jwt-token");
    const refreshToken = response.headers.get("x-jwt-refresh-token");

    if (!token || !refreshToken) {
      throw new Error(
        `QIVOS API did not return required headers. Got x-jwt-token: ${!!token}, x-jwt-refresh-token: ${!!refreshToken}`,
      );
    }

    console.log("[QIVOS] Tokens extracted from headers");

    // Parse expiry from tokens
    let expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
    let refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf-8"),
        ) as any;
        if (payload.exp) {
          const expTime = new Date(payload.exp * 1000);
          expiresAt = new Date(expTime.getTime() - 5 * 60 * 1000);
          console.log(
            "[QIVOS] Access token expires at:",
            expTime,
            "will refresh at:",
            expiresAt,
          );
        }
      }
    } catch (parseError) {
      console.warn(
        "[QIVOS] Could not parse access token expiry from JWT:",
        parseError,
      );
    }

    try {
      const parts = refreshToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf-8"),
        ) as any;
        if (payload.exp) {
          refreshTokenExpiresAt = new Date(payload.exp * 1000);
          console.log(
            "[QIVOS] Refresh token expires at:",
            refreshTokenExpiresAt,
          );
        }
      }
    } catch (parseError) {
      console.warn(
        "[QIVOS] Could not parse refresh token expiry from JWT:",
        parseError,
      );
    }

    return { token, refreshToken, expiresAt, refreshTokenExpiresAt };
  } catch (error) {
    console.error("[QIVOS] Login failed:", error);
    throw error;
  }
}

/**
 * Refresh QIVOS token using the refresh token endpoint (preferred)
 */
async function refreshQIVOSTokenViaRefreshToken(refreshToken: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  try {
    console.log("[QIVOS] Refreshing token using refresh token...");
    console.log("[QIVOS] Refresh URL:", QIVOS_REFRESH_URL);

    const response = await fetch(QIVOS_REFRESH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-jwt-refresh-token": refreshToken,
      },
      body: JSON.stringify({}),
    });

    const responseText = await response.text();
    console.log("[QIVOS] Refresh response body:", responseText);

    // Parse response to check for API-level errors
    let responseData: any = {};
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.warn("[QIVOS] Could not parse response as JSON");
    }

    // Check for API errors in response body
    if (responseData.success === false) {
      const reason = responseData.payload?.REASON || "Unknown error";
      throw new Error(
        `QIVOS refresh failed: ${response.status} - ${reason} - ${responseText}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `QIVOS refresh error: ${response.status} ${response.statusText} - ${responseText}`,
      );
    }

    // New access token is returned in the x-jwt-token header
    const newToken = response.headers.get("x-jwt-token");

    if (!newToken) {
      throw new Error(
        `QIVOS refresh endpoint did not return x-jwt-token header`,
      );
    }

    console.log("[QIVOS] New access token obtained from refresh");

    // Parse expiry from token
    let expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
    try {
      const parts = newToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf-8"),
        ) as any;
        if (payload.exp) {
          const expTime = new Date(payload.exp * 1000);
          expiresAt = new Date(expTime.getTime() - 5 * 60 * 1000);
          console.log(
            "[QIVOS] New token expires at:",
            expTime,
            "will refresh at:",
            expiresAt,
          );
        }
      }
    } catch (parseError) {
      console.warn("[QIVOS] Could not parse new token expiry:", parseError);
    }

    return { token: newToken, expiresAt };
  } catch (error) {
    console.error("[QIVOS] Failed to refresh token via refresh token:", error);
    throw error;
  }
}

/**
 * Refresh QIVOS JWT Token - tries refresh token first, falls back to login
 */
export async function refreshQIVOSToken(): Promise<string> {
  try {
    console.log("[QIVOS] Starting token refresh process...");

    // Try to use existing refresh token first
    const existingToken = await prisma.qIVOSToken.findFirst({
      orderBy: { createdAt: "desc" },
    });

    if (
      existingToken?.refreshToken &&
      existingToken.refreshTokenExpiresAt > new Date()
    ) {
      try {
        console.log(
          "[QIVOS] Attempting refresh using existing refresh token...",
        );
        const { token, expiresAt } = await refreshQIVOSTokenViaRefreshToken(
          existingToken.refreshToken,
        );

        // Update database with new access token
        await prisma.qIVOSToken.update({
          where: { id: existingToken.id },
          data: {
            token,
            expiresAt,
            updatedAt: new Date(),
          },
        });

        // Also update environment for immediate use
        process.env.QIVOS_OTP_JWT_TOKEN = token;

        console.log(
          "[QIVOS] Token refreshed successfully via refresh token. Expires at:",
          expiresAt,
        );
        return token;
      } catch (refreshError) {
        console.warn(
          "[QIVOS] Refresh token attempt failed, falling back to login:",
          refreshError,
        );
        // Fall through to login
      }
    }

    // If no valid refresh token, do full login
    console.log(
      "[QIVOS] No valid refresh token available, performing full login...",
    );
    const { token, refreshToken, expiresAt, refreshTokenExpiresAt } =
      await loginQIVOS();

    // Store in database
    await prisma.qIVOSToken.deleteMany({}); // Keep only the latest token
    await prisma.qIVOSToken.create({
      data: {
        token,
        expiresAt,
        refreshToken,
        refreshTokenExpiresAt,
      },
    });

    // Also update environment for immediate use
    process.env.QIVOS_OTP_JWT_TOKEN = token;

    console.log("[QIVOS] Token obtained via login. Expires at:", expiresAt);

    return token;
  } catch (error) {
    console.error("[QIVOS] Failed to refresh token:", error);
    throw error;
  }
}

/**
 * Get the current valid QIVOS token
 */
export async function getQIVOSToken(): Promise<string> {
  try {
    const tokenRecord = await prisma.qIVOSToken.findFirst({
      orderBy: {
        createdAt: "desc",
      },
    });

    // // If token exists and hasn't expired, return it
    if (tokenRecord && tokenRecord.expiresAt > new Date()) {
      return tokenRecord.token;
    }

    console.log("[QIVOS] Token expired or not found, refreshing...");
    return await refreshQIVOSToken();
  } catch (error) {
    console.error("[QIVOS] Failed to get token:", error);
    throw error;
  }
}

/**
 * Check if token needs refresh
 */
export async function isQIVOSTokenExpired(): Promise<boolean> {
  try {
    const tokenRecord = await prisma.qIVOSToken.findFirst({
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!tokenRecord) return true;
    return tokenRecord.expiresAt <= new Date();
  } catch (error) {
    console.error("[QIVOS] Failed to check token expiry:", error);
    return true;
  }
}
