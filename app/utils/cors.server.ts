import { ALLOWED_SHOPIFY_ORIGIN } from "./constants";

export function getCorsHeaders(origin: string | null, methods: string = "POST, OPTIONS") {
  const allowedOrigin =
    origin === ALLOWED_SHOPIFY_ORIGIN ? origin : ALLOWED_SHOPIFY_ORIGIN;

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-shopify-shop-domain, x-shop-domain, x-shop-domain-name",
  };
}
