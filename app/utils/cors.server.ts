// import {
//   ALLOWED_SHOPIFY_ORIGIN,
//   SHOPIFY_EXTENSION_ORIGIN
// } from "./constants";

// export function getCorsHeaders(origin: string | null, methods: string = "POST, OPTIONS") {
//   const allowedOrigins = new Set([
//     ALLOWED_SHOPIFY_ORIGIN,
//     SHOPIFY_EXTENSION_ORIGIN,
//   ]);
//   const allowedOrigin = origin && allowedOrigins.has(origin)
//     ? origin
//     : ALLOWED_SHOPIFY_ORIGIN;

//   return {
//     "Access-Control-Allow-Origin": allowedOrigin,
//     "Access-Control-Allow-Methods": methods,
//     "Access-Control-Allow-Headers":
//       "Content-Type, Authorization, x-shopify-shop-domain, x-shop-domain, x-shop-domain-name",
//   };
// }

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, x-shopify-shop-domain, x-shop-domain, x-shop-domain-name",
  "Access-Control-Max-Age": "86400",
};

export function getCorsHeaders(
  origin: string | null,
  methods: string = "POST, OPTIONS",
) {
  const allowedOrigin =
    origin && origin !== "null"
      ? origin
      : CORS_HEADERS["Access-Control-Allow-Origin"];

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, x-shopify-shop-domain, x-shop-domain, x-shop-domain-name",
    "Access-Control-Max-Age": "86400",
  };

  // If an explicit origin is provided, allow credentials.
  if (origin && origin !== "null") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}
