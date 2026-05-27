import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { authenticateApiProxyRequest } from "../../utils/api-proxy-auth.server";
import { getQIVOSToken } from "../../utils/qivos-token.server";
import { ensureStoreRecord, resolveCurrentShop } from "../../utils/store.server";
import { getAdminGraphqlClient, type AdminGraphqlClient } from "../../utils/shopify-admin.server";
import { getCorsHeaders } from "../../utils/cors.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../../utils/constants";
import {
  extractStringValue,
  extractObjectRecord,
  findFirstNestedValue,
} from "../../utils/qivos-utils.server";

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
  const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: corsHeaders,
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
              metafield(namespace: "custom", key: "Phone") {
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
                metafield(namespace: "custom", key: "Phone") {
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
    return {
      ...body,
      pagination: body.pagination ?? { page: 1, pageSize: 100 },
      sorting: body.sorting ?? { sortingField: "ID", sortingOrder: "DESC" },
    };
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

// ─── Phone utils ──────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function phonesMatch(
  firstPhone: string,
  secondPhone: string | null | undefined,
): boolean {
  if (!secondPhone) return false;
  const a = normalizePhone(firstPhone);
  const b = normalizePhone(secondPhone);
  return Boolean(a) && a === b;
}

function buildPhoneSearchVariants(phone: string): string[] {
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

function emailsMatch(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const corsHeaders = getCorsHeaders(request.headers.get("Origin"));

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let body: PersonsSearchBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
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
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const { shop: _shop, ...bodyWithoutShop } = requestBody;
  const payload = buildSearchPayload(bodyWithoutShop);
  if (!payload) {
    return new Response(
      JSON.stringify({
        error:
          "Provide either criteriaList or telephoneNumber/mobileNumber/emailAddress in the request body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
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
        headers: { "Content-Type": "application/json", ...corsHeaders },
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
  if(qivosPersons.map((data: any) => data.loyaltyMembershipData[0].active).includes(false)){
    throw new Response(JSON.stringify({ error: "Active loyalty membership not exists for this person" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const qivosPhone = qivosPersons
    .map((p) => extractPhoneFromQivosPerson(p))
    .find(Boolean);

  const qivosEmail = qivosPersons
    .map((p) => extractEmailFromQivosPerson(p))
    .find(Boolean);

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

  // ── Build response ───────────────────────────────────────────────────────
  const matchResult = buildMatchResponse({
    identifier,
    qivosPersonExists,
    qivosPhone,
    qivosEmail,
    shopifyCustomer,
    shop,
  });

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
    }),
    {
      status: thirdPartyResponse.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    },
  );
};
