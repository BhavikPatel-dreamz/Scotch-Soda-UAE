import { getQIVOSToken } from "./qivos-token.server";
import { QIVOS_API_BASE_URL } from "./constants";

/**
 * Make a request to QIVOS API with automatic token refresh
 */
export async function qivosApiCall<T = any>(
  endpoint: string,
  options: RequestInit & { method?: string } = {},
): Promise<T> {
  const token = await getQIVOSToken();

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");

  const response = await fetch(`${QIVOS_API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `QIVOS API error: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

/**
 * Get the current QIVOS JWT token for custom requests
 */
export async function getQIVOSTokenForRequest(): Promise<string> {
  return await getQIVOSToken();
}
