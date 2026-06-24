import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import { getQIVOSToken } from "../../utils/qivos-token.server";
import { ensureStoreRecord, resolveCurrentShop } from "../../utils/store.server";
import { getAdminGraphqlClient, type AdminGraphqlClient } from "../../utils/shopify-admin.server";
import { CORS_HEADERS } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import {
  backfillMissingQivosPersonDetails,
  extractPersonQCCode,
  fetchShopifyCustomerProfile,
} from "../../utils/qivos-person-backfill.server";
import {
  extractStringValue,
  extractObjectRecord,
  findFirstNestedValue,
  normalizeBooleanValue,
  phonesMatch,
  emailsMatch,
  buildPhoneSearchVariants,
} from "../../utils/qivos-utils.server";
import {
  syncCustomerMetafields,
  saveCustomerIdentityMetafields,
} from "../../utils/shopify-customer-metafields.server";
import { collectInactiveLoyaltyMemberships, extractLoyaltyQCCode, normalizeInactiveValue } from "../customer-account.metafields";

const QIVOS_PERSONS_SEARCH_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons/search`;

type PersonsSearchBody = {
  criteriaList?: unknown[];
  pagination?: {
    page?: number;
    pageSize?: number;
  };
  sorting?: {
    sortingField?: string;
    sortingOrder?: string;
  };
  countryCode?: string;
  mobileNumber?: string;
  telephoneNumber?: string;
  telephoneType?: string;
  isPrimary?: boolean;
  emailAddress?: string;
  shop?: string;
  [key: string]: unknown;
};

type ShopifyCustomerNode = {
  id: string;
  phone: string | null;
  email: string | null;
};

// ─── Search identifier type ───────────────────────────────────────────────────
type SearchIdentifier =
  | { type: "phone"; value: string }
  | { type: "email"; value: string };

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

// ─── Shopify: find customer by PHONE ─────────────────────────────────────────

async function findShopifyCustomerByPhone(
  adminClient: AdminGraphqlClient,
  phone: string,
): Promise<ShopifyCustomerNode | null> {
  for (const variant of buildPhoneSearchVariants(phone)) {
    const customer = await searchByStandardPhone(adminClient, variant, phone);
    if (customer) return customer;
  }

  return await searchByPhoneMetafieldFallback(adminClient, phone);
}

async function searchByStandardPhone(
  adminClient: AdminGraphqlClient,
  variant: string,
  originalPhone: string,
): Promise<ShopifyCustomerNode | null> {
  const query = `phone:${JSON.stringify(variant)}`;

  const response = await adminClient.graphql(
    `#graphql
      query CustomersByPhone($query: String!) {
        customers(first: 10, query: $query) {
          edges {
            node {
              id
              phone
              email
              metafield(namespace: "custom", key: "phone") {
                value
              }
            }
          }
        }
      }
    `,
    { variables: { query } },
  );

  const result = await response.json() as {
    data?: {
      customers: {
        edges: Array<{
          node: {
            id: string;
            phone: string | null;
            email: string | null;
            metafield?: { value: string } | null;
          };
        }>;
      };
    };
  };

  const customers = result.data?.customers.edges.map((e) => ({
    id: e.node.id,
    phone: e.node.phone ?? e.node.metafield?.value ?? null,
    email: e.node.email ?? null,
  })) ?? [];

  return (
    customers.find((c) => phonesMatch(originalPhone, c.phone)) ??
    (customers.length > 0 ? customers[0] : null)
  );
}

async function searchByPhoneMetafieldFallback(
  adminClient: AdminGraphqlClient,
  phone: string,
): Promise<ShopifyCustomerNode | null> {
  let cursor: string | null = null;
  const maxPages = 5;

  for (let page = 0; page < maxPages; page++) {
    const response = await adminClient.graphql(
      `#graphql
        query CustomersWithMetafieldPhone($cursor: String) {
          customers(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                phone
                email
                metafield(namespace: "custom", key: "phone") {
                  value
                }
              }
            }
          }
        }
      `,
      { variables: { cursor } },
    );

    const result = await response.json() as {
      data?: {
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{
            node: {
              id: string;
              phone: string | null;
              email: string | null;
              metafield?: { value: string } | null;
            };
          }>;
        };
      };
    };

    const edges = result.data?.customers.edges ?? [];

    for (const edge of edges) {
      const metafieldPhone = edge.node.metafield?.value ?? null;
      const standardPhone = edge.node.phone ?? null;

      if (
        phonesMatch(phone, metafieldPhone) ||
        phonesMatch(phone, standardPhone)
      ) {
        return {
          id: edge.node.id,
          phone: metafieldPhone ?? standardPhone,
          email: edge.node.email ?? null,
        };
      }
    }

    const pageInfo = result.data?.customers.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return null;
}

// ─── Shopify: find customer by EMAIL ─────────────────────────────────────────

async function findShopifyCustomerByEmail(
  adminClient: AdminGraphqlClient,
  email: string,
): Promise<ShopifyCustomerNode | null> {
  const query = `email:${JSON.stringify(email.toLowerCase().trim())}`;

  const response = await adminClient.graphql(
    `#graphql
      query CustomersByEmail($query: String!) {
        customers(first: 5, query: $query) {
          edges {
            node {
              id
              phone
              email
            }
          }
        }
      }
    `,
    { variables: { query } },
  );

  const result = await response.json() as {
    data?: {
      customers: {
        edges: Array<{
          node: {
            id: string;
            phone: string | null;
            email: string | null;
          };
        }>;
      };
    };
  };

  const customers = result.data?.customers.edges.map((e) => ({
    id: e.node.id,
    phone: e.node.phone ?? null,
    email: e.node.email ?? null,
  })) ?? [];

  return (
    customers.find(
      (c) => c.email?.toLowerCase().trim() === email.toLowerCase().trim(),
    ) ??
    (customers.length > 0 ? customers[0] : null)
  );
}

// ─── Unified Shopify lookup ───────────────────────────────────────────────────

async function findShopifyCustomer(
  adminClient: AdminGraphqlClient,
  identifier: SearchIdentifier,
): Promise<ShopifyCustomerNode | null> {
  if (identifier.type === "email") {
    return findShopifyCustomerByEmail(adminClient, identifier.value);
  }
  return findShopifyCustomerByPhone(adminClient, identifier.value);
}

// ─── Build search payload ─────────────────────────────────────────────────────

function buildSearchPayload(body: PersonsSearchBody) {
  // If caller already provided a full criteriaList — use it as-is
  if (Array.isArray(body.criteriaList) && body.criteriaList.length > 0) {
    const payload = {
      ...body,
      pagination: body.pagination ?? { page: 1, pageSize: 100 },
      sorting: body.sorting ?? { sortingField: "ID", sortingOrder: "DESC" },
    };

    // Remove internal fields that QIVOS doesn't recognize
    delete (payload as any).shop;
    delete (payload as any).customerId;
    delete (payload as any).metafieldNamespace;
    delete (payload as any).loyaltySync;

    return payload;
  }

  // Auto-build from emailAddress field
  if (body.emailAddress) {
    return {
      criteriaList: [
        {
          criteriaType: "EMAIL",
          emailAddress: body.emailAddress,
          isPrimary: body.isPrimary ?? true,
        },
      ],
      pagination: body.pagination ?? { page: 1, pageSize: 100 },
      sorting: body.sorting ?? { sortingField: "ID", sortingOrder: "DESC" },
    };
  }

  // Auto-build from telephone fields
  const telephoneNumber = body.telephoneNumber ?? body.mobileNumber;
  const countryCode = body.countryCode ?? "in";

  if (telephoneNumber) {
    return {
      criteriaList: [
        {
          criteriaType: "TELEPHONE",
          countryCode,
          telephoneNumber,
          telephoneType: body.telephoneType ?? "MOBILE",
          isPrimary: body.isPrimary ?? true,
        },
      ],
      pagination: body.pagination ?? { page: 1, pageSize: 100 },
      sorting: body.sorting ?? { sortingField: "ID", sortingOrder: "DESC" },
    };
  }

  return null;
}

// ─── Extract identifier from request ─────────────────────────────────────────

function extractIdentifierFromRequest(
  body: PersonsSearchBody,
): SearchIdentifier | undefined {
  // 1. Direct email field on body
  if (typeof body.emailAddress === "string" && body.emailAddress.trim()) {
    return { type: "email", value: body.emailAddress.trim() };
  }

  // 2. Direct phone fields on body
  const directPhone = body.telephoneNumber ?? body.mobileNumber;
  if (typeof directPhone === "string" && directPhone.trim()) {
    return { type: "phone", value: directPhone.trim() };
  }

  if (!Array.isArray(body.criteriaList)) return undefined;

  // 3. Scan criteriaList
  for (const item of body.criteriaList) {
    const record = extractObjectRecord(item);
    if (!record) continue;

    const criteriaType = extractStringValue(record.criteriaType);

    if (criteriaType === "EMAIL") {
      const email = extractStringValue(record.emailAddress);
      if (email) return { type: "email", value: email };
    }

    if (criteriaType === "TELEPHONE") {
      const phone = extractStringValue(record.telephoneNumber);
      if (phone) return { type: "phone", value: phone };
    }
  }

  return undefined;
}


// ─── QIVOS response parsers ───────────────────────────────────────────────────

function collectObjectArrays(
  value: unknown,
  keyName: string,
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    const record = extractObjectRecord(current);
    if (!record) continue;

    const candidate = record[keyName];
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const objectItem = extractObjectRecord(item);
        if (objectItem) results.push(objectItem);
      }
    }

    for (const nestedValue of Object.values(record)) {
      if (nestedValue && typeof nestedValue === "object") queue.push(nestedValue);
    }
  }

  return results;
}

function extractQivosPersons(
  responseData: unknown,
): Record<string, unknown>[] {
  const rootRecord = extractObjectRecord(responseData);
  const payloadRecord = extractObjectRecord(rootRecord?.payload);
  const payloadData = payloadRecord?.data;

  if (Array.isArray(payloadData)) {
    return payloadData
      .map((item) => extractObjectRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const persons = collectObjectArrays(responseData, "persons");
  if (persons.length > 0) return persons;

  if (Array.isArray(responseData)) {
    return responseData
      .map((item) => extractObjectRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const singleRecord = extractObjectRecord(responseData);
  return singleRecord ? [singleRecord] : [];
}

function extractPhoneFromQivosPerson(
  person: Record<string, unknown>,
): string | undefined {
  return (
    extractStringValue(person.telephoneNumber) ??
    extractStringValue(person.mobileNumber) ??
    extractStringValue(person.phone) ??
    findFirstNestedValue(person.telephoneList, [
      "telephoneNumber",
      "mobileNumber",
      "phone",
    ]) ??
    findFirstNestedValue(person, ["telephoneNumber", "mobileNumber", "phone"])
  );
}

function extractEmailFromQivosPerson(
  person: Record<string, unknown>,
): string | undefined {
  return (
    extractStringValue(person.emailAddress) ??
    extractStringValue(person.email) ??
    findFirstNestedValue(person.emailList, ["emailAddress", "email"]) ??
    findFirstNestedValue(person, ["emailAddress", "email"])
  );
}

// function extractLoyaltyQCCode(value: unknown): string | undefined {
//   const record = extractObjectRecord(value);
//   if (!record) return undefined;

//   return (
//     extractStringValue(record.QCCode) ??
//     extractStringValue(record.qcCode) ??
//     extractStringValue(record.loyaltyQCCode) ??
//     extractStringValue(record.loyaltyCode) ??
//     extractStringValue(record.membershipQCCode) ??
//     extractStringValue(record.membershipCode) ??
//     extractStringValue(record.code)
//   );
// }

// function collectInactiveLoyaltyMemberships(
//   person: Record<string, unknown>,
// ): Array<{ personQCCode: string; loyaltyQCCode: string }> {
//   const personQCCode = extractPersonQCCode(person);
//   if (!personQCCode) return [];

//   const memberships = Array.isArray(person.loyaltyMembershipData)
//     ? person.loyaltyMembershipData
//     : [];

//   return memberships.flatMap((membership) => {
//     const record = extractObjectRecord(membership);
//     if (!record || !normalizeInactiveValue(record.active)) return [];

//     const loyaltyQCCode = extractLoyaltyQCCode(record);
//     if (!loyaltyQCCode) return [];

//     return [{ personQCCode, loyaltyQCCode }];
//   });
// }

function extractPointBalanceFromQivosPerson(
  person: Record<string, unknown>,
): string | undefined {
  if (!person || typeof person !== "object") {
    return undefined;
  }

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (!Array.isArray(loyaltyMembershipData)) {
    return undefined;
  }

  for (const membership of loyaltyMembershipData) {
    if (!membership || typeof membership !== "object") {
      continue;
    }

    const record = membership as {
      active?: unknown;
      pointBalance?: unknown;
    };

    if (record.active === false) {
      continue;
    }

    if (typeof record.pointBalance === "string" && record.pointBalance.trim().length > 0) {
      return record.pointBalance.trim();
    }

    if (typeof record.pointBalance === "number") {
      return String(record.pointBalance);
    }
  }

  return undefined;
}

function extractCanRedeemFromQivosPerson(
  person: Record<string, unknown>,
): boolean | undefined {
  if (!person || typeof person !== "object") {
    return undefined;
  }

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (!Array.isArray(loyaltyMembershipData)) {
    return undefined;
  }

  for (const membership of loyaltyMembershipData) {
    if (!membership || typeof membership !== "object") {
      continue;
    }

    const record = membership as {
      attributes?: unknown;
    };
    const attributes = Array.isArray(record.attributes)
      ? record.attributes
      : [];

    for (const attribute of attributes) {
      if (!attribute || typeof attribute !== "object") {
        continue;
      }

      const attributeRecord = attribute as {
        attributeName?: unknown;
        name?: unknown;
        attributeKey?: unknown;
        attributeValue?: unknown;
        value?: unknown;
      };

      const attributeName =
        typeof attributeRecord.attributeName === "string"
          ? attributeRecord.attributeName.trim()
          : typeof attributeRecord.name === "string"
            ? attributeRecord.name.trim()
            : typeof attributeRecord.attributeKey === "string"
              ? attributeRecord.attributeKey.trim()
              : "";

      if (attributeName.toUpperCase() !== "CANREDEEM") {
        continue;
      }

      return (
        normalizeBooleanValue(attributeRecord.attributeValue) ??
        normalizeBooleanValue(attributeRecord.value)
      );
    }
  }

  return undefined;
}

function extractLoyaltyTierFromQivosPerson(
  person: Record<string, unknown>,
): string | undefined {
  if (!person || typeof person !== "object") {
    return undefined;
  }

  const tierFields = [
    "tier",
    "membershipTier",
    "loyaltyTier",
    "tierCode",
    "tierName",
    "tier_name",
  ];

  for (const field of tierFields) {
    const value = extractStringValue(person[field]);
    if (value) {
      return value;
    }
  }

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (Array.isArray(loyaltyMembershipData)) {
    for (const membership of loyaltyMembershipData) {
      if (!membership || typeof membership !== "object") {
        continue;
      }

      const record = membership as Record<string, unknown>;
      for (const field of tierFields) {
        const value = extractStringValue(record[field]);
        if (value) {
          return value;
        }
      }
    }
  }

  return undefined;
}

function getFirstLoyaltyMembership(
  person: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (Array.isArray(loyaltyMembershipData)) {
    for (const membership of loyaltyMembershipData) {
      const record = extractObjectRecord(membership);
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  return extractObjectRecord(loyaltyMembershipData);
}

async function syncInactiveMemberships(
  request: Request,
  inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>,
  shop?: string,
  customerId?: string | null,
): Promise<Array<{ personQCCode: string; loyaltyQCCode: string; ok: boolean; status: number; error?: string }>> {
  const results: Array<{
    personQCCode: string;
    loyaltyQCCode: string;
    ok: boolean;
    status: number;
    error?: string;
  }> = [];

  if (inactiveMemberships.length === 0) return results;

  const originUrl = new URL(request.url);

  for (const membership of inactiveMemberships) {
    const statusUrl = new URL(request.url);
    statusUrl.pathname = `/api/proxy/persons/${encodeURIComponent(
      membership.personQCCode,
    )}/loyalty-membership/${encodeURIComponent(
      membership.loyaltyQCCode,
    )}/status`;
    statusUrl.search = "";

try {
       const statusResponse = await fetch(statusUrl.toString(), {
         method: "POST",
         headers: {
           Accept: "application/json",
           "Content-Type": "application/json",
           Origin: originUrl.origin,
         },
         body: JSON.stringify({
           personQCCode: membership.personQCCode,
           loyaltyQCCode: membership.loyaltyQCCode,
           active: true,
           shop,
           customerId,
         }),
       });

      results.push({
        personQCCode: membership.personQCCode,
        loyaltyQCCode: membership.loyaltyQCCode,
        ok: statusResponse.ok,
        status: statusResponse.status,
      });
    } catch (error) {
      results.push({
        personQCCode: membership.personQCCode,
        loyaltyQCCode: membership.loyaltyQCCode,
        ok: false,
        status: 0,
        error:
          error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }

  return results;
}

// ─── Match response builder ───────────────────────────────────────────────────

function buildMatchResponse(params: {
  identifier: SearchIdentifier;
  qivosPersonExists: boolean;
  qivosPhone?: string;
  qivosEmail?: string;
  shopifyCustomer: ShopifyCustomerNode | null;
  shop?: string | null;
}) {
  const {
    identifier,
    qivosPersonExists,
    qivosPhone,
    qivosEmail,
    shopifyCustomer,
    shop,
  } = params;

  const isPhoneSearch = identifier.type === "phone";
  const isEmailSearch = identifier.type === "email";

  const shopifyPhone = shopifyCustomer?.phone ?? null;
  const shopifyEmail = shopifyCustomer?.email ?? null;

  // Determine match based on search type
  const qivosMatched = isPhoneSearch
    ? phonesMatch(identifier.value, qivosPhone)
    : emailsMatch(identifier.value, qivosEmail);

  const shopifyMatched = isPhoneSearch
    ? phonesMatch(identifier.value, shopifyPhone)
    : emailsMatch(identifier.value, shopifyEmail);

  const bothMatched = qivosPersonExists && qivosMatched && shopifyMatched;

  const base = {
    inputIdentifier: identifier.value,
    identifierType: identifier.type,
    qivosPhone: qivosPhone ?? null,
    qivosEmail: qivosEmail ?? null,
    shopifyPhone,
    shopifyEmail,
    qivosPersonExists,
    shopifyCustomerExists: Boolean(shopifyCustomer),
    shopifyCustomerId: shopifyCustomer?.id ?? null,
    shop: shop ?? null,
  };

  if (bothMatched) {
    return {
      success: true,
      message: `${isEmailSearch ? "Email" : "Phone number"} matched in QIVOS and Shopify customer.`,
      matched: true,
      ...base,
    };
  }

  if (!qivosPersonExists && !shopifyCustomer) {
    return {
      success: false,
      message: `${isEmailSearch ? "Email" : "Phone number"} does not exist in QIVOS or Shopify.`,
      matched: false,
      ...base,
    };
  }

  if (!qivosPersonExists) {
    return {
      success: false,
      message: `${isEmailSearch ? "Email" : "Phone number"} not found in QIVOS but exists in Shopify.`,
      matched: false,
      ...base,
    };
  }

  if (!shopifyCustomer) {
    return {
      success: false,
      message: `${isEmailSearch ? "Email" : "Phone number"} found in QIVOS but not in Shopify.`,
      matched: false,
      ...base,
    };
  }

  return {
    success: false,
    message: `${isEmailSearch ? "Email" : "Phone number"} found in both systems but does not match exactly.`,
    matched: false,
    ...base,
  };
}


// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body: PersonsSearchBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  let proxyContext:
    | Awaited<ReturnType<typeof authenticateApiProxyRequest>>
    | undefined;

  try {
    proxyContext = await authenticateApiProxyRequest(request);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to authenticate app proxy request:", error);
  }

  const requestBody: PersonsSearchBody = {
    ...body,
    shop: body.shop ?? proxyContext?.shop,
  };

  await ensureStoreRecord(request, requestBody as Record<string, unknown>);

  // ── Extract identifier (phone OR email) ──────────────────────────────────
  const identifier = extractIdentifierFromRequest(requestBody);
  if (!identifier) {
    return new Response(
      JSON.stringify({
        error:
          "Provide either criteriaList (TELEPHONE or EMAIL) or telephoneNumber/mobileNumber/emailAddress in the request body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  const bodyWithoutShop = { ...requestBody };
  delete bodyWithoutShop.shop;
  const payload = buildSearchPayload(bodyWithoutShop);
  if (!payload) {
    return new Response(
      JSON.stringify({
        error:
          "Provide either criteriaList or telephoneNumber/mobileNumber/emailAddress in the request body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  // ── QIVOS token ──────────────────────────────────────────────────────────
  let token: string;
  try {
    token = await getQIVOSToken();
  } catch (error) {
    console.error("Failed to obtain QIVOS token:", error);
    return new Response(
      JSON.stringify({ error: "Failed to obtain QIVOS token" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  // ── QIVOS search ─────────────────────────────────────────────────────────
  const thirdPartyResponse = await fetch(QIVOS_PERSONS_SEARCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-jwt-token": token,
    },
    body: JSON.stringify(payload),
  });

  const text = await thirdPartyResponse.text();
  let responseData: unknown;
  try {
    responseData = JSON.parse(text);
  } catch {
    responseData = { raw: text };
  }

  const qivosPersons = extractQivosPersons(responseData);
  const qivosPersonExists = qivosPersons.length > 0;
  const inactiveMemberships = qivosPersons.flatMap((person) =>
    collectInactiveLoyaltyMemberships(person),
  );

// Note: Inactive memberships are NOT auto-activated here.
// User must explicitly activate via the UI button in activateInactiveMemberships.
const inactiveMembershipSyncResults: any[] = [];

  const qivosPhone = qivosPersons
    .map((p) => extractPhoneFromQivosPerson(p))
    .find(Boolean);

  const qivosEmail = qivosPersons
    .map((p) => extractEmailFromQivosPerson(p))
    .find(Boolean);

  const qivosPerson = qivosPersons[0];
  const qivosFirstName = qivosPerson ? findFirstNestedValue(qivosPerson, ["firstName", "givenName"]) : undefined;
  const qivosLastName = qivosPerson ? findFirstNestedValue(qivosPerson, ["lastName", "familyName"]) : undefined;
  const qivosPointBalance = qivosPersons
    .map((p) => extractPointBalanceFromQivosPerson(p))
    .find(Boolean);
  const qivosCanRedeem = qivosPersons
    .map((p) => extractCanRedeemFromQivosPerson(p))
    .find((value) => value !== undefined);
  const qivosTier = qivosPerson ? extractLoyaltyTierFromQivosPerson(qivosPerson) : undefined;
  const qivosPersonQCCode = qivosPerson ? extractPersonQCCode(qivosPerson) : undefined;
  const qivosLoyaltyQCCode = qivosPerson
    ? extractLoyaltyQCCode(getFirstLoyaltyMembership(qivosPerson))
    : undefined;
  const shopCountryCode = typeof requestBody.countryCode === "string"
    ? requestBody.countryCode.toUpperCase()
    : undefined;

  // ── Shopify lookup ───────────────────────────────────────────────────────
  let shop: string | null = null;
  let shopifyCustomer: ShopifyCustomerNode | null = null;
  let shopifyLookupError: string | null = null;

  try {
    shop = await resolveCurrentShop(
      request,
      requestBody as Record<string, unknown>,
    );
    if (shop) {
      const adminClient = await getAdminGraphqlClient(shop);
      shopifyCustomer = await findShopifyCustomer(adminClient, identifier);
    } else {
      shopifyLookupError =
        "Shop could not be resolved; Shopify customer could not be checked.";
    }
  } catch (error) {
    console.error("Failed to search Shopify customer:", error);
    shopifyLookupError =
      error instanceof Error
        ? error.message
        : "Shopify customer check failed unexpectedly";
  }

  if (qivosPersonExists && shop && shopifyCustomer) {
    let shopifyProfile = null;
    try {
      shopifyProfile = await fetchShopifyCustomerProfile({
        shop,
        customerId: shopifyCustomer.id,
      });
    } catch (error) {
      console.warn("[persons.search] Failed to load Shopify profile for person backfill:", {
        shop,
        shopifyCustomerId: shopifyCustomer.id,
        error,
      });
    }

    const backfillResults = await Promise.all(
      qivosPersons.map((person) =>
        backfillMissingQivosPersonDetails({
          shop,
          customerId: shopifyCustomer.id,
          person,
          profile: shopifyProfile,
        }),
      ),
    );

    if (backfillResults.some((result) => result.namePatched || result.emailPatched)) {
      console.log("[persons.search] Backfilled missing person details from Shopify profile:", {
        shop,
        shopifyCustomerId: shopifyCustomer.id,
        results: backfillResults,
      });
    }
  }

  // ── Build response ───────────────────────────────────────────────────────
  const matchResult = buildMatchResponse({
    identifier,
    qivosPersonExists,
    qivosPhone,
    qivosEmail,
    shopifyCustomer,
    shop,
  });

  // If person found in QIVOS but not in Shopify, sync metafields for the current searcher
  if (qivosPersonExists && !shopifyCustomer && requestBody.customerId && shop) {
    try {
      await syncCustomerMetafields(request, {
        ...requestBody,
        customerId: requestBody.customerId as string,
        loyaltySync: true
      }, responseData);
    } catch (error) {
      console.error("Failed to sync customer metafields during search:", error);
    }
    try {
      await saveCustomerIdentityMetafields({
        shop,
        customerId: String(requestBody.customerId),
        values: {
          qivosNote: "Phone number found in QIVOS but not in Shopify",
          loyaltySync: true,
        },
      });
    } catch (error) {
      console.error("Failed to save QIVOS note metafield during search:", error);
    }
  }

  const baseResponse =
    responseData && typeof responseData === "object"
      ? (responseData as Record<string, unknown>)
      : { data: responseData };

  return new Response(
    JSON.stringify({
      ...baseResponse,
      phoneCheck: {
        ...matchResult,
        ...(shopifyLookupError ? { shopifyLookupError } : {}),
      },
      inactiveMembershipSync: inactiveMembershipSyncResults,
      inactiveMemberships,
      personQCCode: qivosPersonQCCode ?? undefined,
      loyaltyQCCode: qivosLoyaltyQCCode ?? undefined,
      pointBalance: qivosPointBalance,
      redeemPoint: qivosPointBalance,
      canRedeem: qivosCanRedeem === true,
      tier: qivosTier ?? undefined,
      loyaltySync: true,
      firstName: qivosFirstName,
      lastName: qivosLastName,
      email: qivosEmail ?? shopifyCustomer?.email ?? undefined,
      phone: qivosPhone ?? shopifyCustomer?.phone ?? undefined,
      shopCountryCode,
    }),
    {
      status: thirdPartyResponse.status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    },
  );
};
