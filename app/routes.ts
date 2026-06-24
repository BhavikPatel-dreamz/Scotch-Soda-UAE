import {
  type RouteConfig,
  route,
  index,
  prefix,
} from "@react-router/dev/routes";

export default [
  // Auth routes
  route("auth/*", "routes/auth.$.tsx"),
  route("auth/login", "routes/auth.login/route.tsx"),
  route("api/backfill/stores", "routes/api.backfill.stores.tsx"),
  route(
    "customer-account/metafields",
    "routes/customer-account.metafields.tsx",
  ),
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
  ]),

  // Webhook routes
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.tsx"),
  route("webhooks/app/scopes_update", "routes/webhooks.app.scopes_update.tsx"),
  route("webhooks/customers/create", "routes/webhooks.customers.create.tsx"),
  route("webhooks/orders/create", "routes/webhooks.orders.create.tsx"),
  route("webhooks/orders/paid", "routes/webhooks.orders.paid.tsx"),
  route("webhooks/orders/cancelled", "routes/webhooks.orders.cancelled.tsx"),
  route("webhooks/orders/updated", "routes/webhooks.orders.updated.tsx"),
  route("webhooks/shop/update", "routes/webhooks.shop.update.tsx"),

  // API Proxy routes (using prefix for folder organization)
  ...prefix("api/proxy", [
    route("sendOTP", "routes/api.proxy/sendOTP.tsx"),
    route("validateOTP", "routes/api.proxy/validateOTP.tsx"),
    route("persons", "routes/api.proxy/persons.tsx"),
    route("persons/search", "routes/api.proxy/persons.search.tsx"),
    route(
      "persons/:personQCCode/details",
      "routes/api.proxy/persons.$personQCCode.details.tsx",
    ),
    route(
      "persons/:personQCCode/loyalty-membership/:loyaltyQCCode/status",
      "routes/api.proxy/persons.$personQCCode.loyalty-membership.$loyaltyQCCode.status.tsx",
    ),
    route(
      "transactions/loyalty",
      "routes/api.proxy/transactions.loyalty.tsx",
    ),
    route("customerCredit", "routes/api.proxy/customerCredit.tsx"),
    route("pointlogs/reserve-points","routes/api.proxy/pointlogs.reserve-points.tsx")
  ]),
  // Index route
  index("routes/_index/route.tsx"),
] satisfies RouteConfig;
