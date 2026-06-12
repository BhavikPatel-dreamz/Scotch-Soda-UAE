/**
 * QIVOS common utility functions for data extraction and normalization
 */

import { authenticateApiProxyRequest } from "./api-proxy-auth.server";
import { getQIVOSToken, refreshQIVOSToken } from "./qivos-token.server";
import { CORS_HEADERS } from "./cors.server";

export function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

export function extractObjectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function extractFirstFromArrayField(
  value: unknown,
  fieldNames: string[],
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const record = extractObjectRecord(item);
    if (!record) {
      continue;
    }

    for (const fieldName of fieldNames) {
      const fieldValue = extractStringValue(record[fieldName]);
      if (fieldValue) {
        return fieldValue;
      }
    }
  }

  return undefined;
}

export function findFirstNestedValue(
  value: unknown,
  candidateKeys: string[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstNestedValue(item, candidateKeys);
      if (nested) {
        return nested;
      }
    }

    return undefined;
  }

  const record = extractObjectRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of candidateKeys) {
    const directValue = extractStringValue(record[key]);
    if (directValue) {
      return directValue;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findFirstNestedValue(nestedValue, candidateKeys);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function normalizeBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

/**
 * Extract person record from QIVOS API response which might be a single record or a list
 */
export function extractQivosPayload(
  responseData: unknown,
): Record<string, unknown> | undefined {
  const root = extractObjectRecord(responseData);
  const payload = extractObjectRecord(root?.payload);

  if (Array.isArray(payload?.data)) {
    // List-style response: { payload: { data: [ personRecord, ... ] } }
    const firstItem = extractObjectRecord((payload!.data as unknown[])[0]);
    return firstItem ?? payload ?? root;
  }

  // Single-record response: { payload: { data: { ... } } }
  const payloadData = extractObjectRecord(payload?.data);
  return payloadData ?? payload ?? root;
}

export function isQivosLogicalFailure(data: unknown): boolean {
  const record = extractObjectRecord(data);
  if (!record) return false;
  // Only treat it as a failure when "success" is explicitly false.
  return record.success === false;
}

export function isBlank(value: string | undefined): boolean {
  return !value || !value.trim();
}


export function jsonResponse(
  body: unknown,
  status: number,
  CORS_HEADERS: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
 
// ─── Parse QIVOS Response Body ────────────────────────────────────────────────
 
export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : null;
  }
}
 
// ─── QIVOS Request with Auto Token Refresh ────────────────────────────────────
 
export async function sendQivosRequest(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const hasBody =
    init.body !== undefined && init.body !== null && init.body !== "";
 
  async function execute(token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (hasBody) headers.set("Content-Type", "application/json");
    headers.set("x-jwt-token", token);
    return fetch(url, { ...init, headers });
  }
 
  const token = await getQIVOSToken();
  console.log(
    `[QIVOS] ${init.method ?? "GET"} ${url} hasBody=${hasBody}`,
  );
 
  let response = await execute(token);
 
  if (response.status === 401) {
    console.warn("[QIVOS] 401 — refreshing token and retrying once.");
    const refreshed = await refreshQIVOSToken();
    response = await execute(refreshed);
  }
 
  return response;
}
 
// ─── Proxy Auth (shared try/catch pattern) ───────────────────────────────────
 
export async function tryAuthenticateProxy(
  request: Request,
): Promise<Awaited<ReturnType<typeof authenticateApiProxyRequest>> | undefined> {
  try {
    return await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[proxy] Failed to authenticate app proxy request:", error);
    return undefined;
  }
}

export function makeOptionsOnlyLoader(allowMethods = "POST, OPTIONS") {
  return async function loader({ request }: { request: Request }) {
 
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
 
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  };
}
 
// ─── Phone Utilities ──────────────────────────────────────────────────────────
 
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}
 
export function phonesMatch(
  first: string,
  second: string | null | undefined,
): boolean {
  if (!second) return false;
  const a = normalizePhone(first);
  const b = normalizePhone(second);
  return Boolean(a) && a === b;
}
 
export function emailsMatch(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}
 
export function buildPhoneSearchVariants(phone: string): string[] {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  const last10 = digits.slice(-10);
 
  const variants = [
    trimmed,
    digits,
    last10,
    trimmed.startsWith("+") ? undefined : `+${digits}`,
    last10 ? `+91${last10}` : undefined,
  ].filter((v): v is string => Boolean(v));
 
  return [...new Set(variants)];
}
 
// ─── Boolean / Active Normalizers ────────────────────────────────────────────
 
/**
 * Normalizes a value to `true | false | null`.
 * Handles: boolean, "true"/"false" strings, `{ value: ... }` wrappers.
 */
export function normalizeActiveValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  if (value && typeof value === "object" && "value" in value) {
    return normalizeActiveValue((value as { value?: unknown }).value);
  }
  return null;
}
 
/**
 * Returns `true` only when `active` is explicitly `false` (i.e. inactive).
 * Mirrors the old `normalizeInactiveValue` used in persons.search.
 */
export function isInactiveMembership(value: unknown): boolean {
  return normalizeActiveValue(value) === false;
}
 
