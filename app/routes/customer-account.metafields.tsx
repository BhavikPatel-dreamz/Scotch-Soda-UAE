import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { creditCustomerStoreCredit } from "../utils/customer-credit.server";
import {
  getCustomerIdentityMetafields,
  saveCustomerIdentityMetafields,
  syncCustomerMetafields,
} from "../utils/shopify-customer-metafields.server";
import {
  extractObjectRecord,
  extractStringValue,
  normalizeBooleanValue,
} from "../utils/qivos-utils.server";
import {
  normalizeShopDomain,
  toShopifyCustomerGid,
} from "../utils/store.server";
import { getAdminGraphqlClient } from "../utils/shopify-admin.server";
import { getCorsHeaders } from "../utils/cors.server";
import { getQIVOSToken } from "../utils/qivos-token.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../utils/constants";
import {
  backfillMissingQivosPersonDetails,
  fetchShopifyCustomerProfile,
  qivosPersonNeedsShopifyProfileBackfill,
} from "../utils/qivos-person-backfill.server";

const QIVOS_PERSONS_SEARCH_URL = `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons/search`;

type QivosSearchCriteria = {
  criteriaType: "TELEPHONE";
  countryCode: string;
  telephoneNumber: string;
  telephoneType: string;
  isPrimary: boolean;
};

type QivosSearchPayload = {
  criteriaList: QivosSearchCriteria[];
  pagination: {
    page: number;
    pageSize: number;
  };
  sorting: {
    sortingField: string;
    sortingOrder: string;
  };
};

type CustomerIdentitySnapshot = Awaited<
  ReturnType<typeof getCustomerIdentityMetafields>
>;

function normalizePhoneForQivos(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

const shopCountriesCache = new Map<string, { code: string; name: string }[]>();

async function fetchShopCountries(shop: string) {
  const cached = shopCountriesCache.get(shop);
  if (cached) return cached;

  try {
    const client = await getAdminGraphqlClient(shop);
    const response = await client.graphql(`
      query GetMarketsCountries {
        markets(first: 50) {
          nodes {
            name
            regions(first: 100) {
              nodes {
                __typename
                ... on MarketRegionCountry {
                  name
                }
              }
            }
          }
        }
      }
    `);

    const body = await response.json();

    type MarketCountryNode = { countryCode?: unknown; name?: unknown };
    type MarketNode = { regions?: { nodes?: MarketCountryNode[] } };

    const markets = (body?.data?.markets?.nodes ?? []) as MarketNode[];
    const countries = markets.flatMap((market) =>
      (market.regions?.nodes ?? [])
        .map((country) => ({
          code:
            typeof country.countryCode === "string"
              ? country.countryCode
              : undefined,
          name: typeof country.name === "string" ? country.name : "",
        }))
        .filter(
          (country): country is { code: string; name: string } =>
            Boolean(country.name && country.code),
        ),
    );

    shopCountriesCache.set(shop, countries);
    return countries;
  } catch (err) {
    console.warn(`[fetchShopCountries] Error for shop=${shop}:`, err);
    return [];
  }
}

function extractPointBalanceFromPerson(person: unknown): string | undefined {
  if (!person || typeof person !== "object") return undefined;

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (!Array.isArray(loyaltyMembershipData)) return undefined;

  // active:false membership પણ pointBalance ધરાવી શકે છે — skip નહીં કરવું.
  // needsActivation flag અલગ handle થાય છે collectInactiveLoyaltyMemberships માં.
  for (const membership of loyaltyMembershipData) {
    if (!membership || typeof membership !== "object") continue;

    const record = membership as { pointBalance?: unknown };

    if (
      typeof record.pointBalance === "string" &&
      record.pointBalance.trim().length > 0
    ) {
      return record.pointBalance.trim();
    }
    if (typeof record.pointBalance === "number") {
      return String(record.pointBalance);
    }
  }

  return undefined;
}

function extractCanRedeemFromPerson(person: unknown): boolean | undefined {
  if (!person || typeof person !== "object") return undefined;

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (!Array.isArray(loyaltyMembershipData)) return undefined;

  for (const membership of loyaltyMembershipData) {
    if (!membership || typeof membership !== "object") continue;

    const record = membership as { attributes?: unknown };
    const attributes = Array.isArray(record.attributes)
      ? record.attributes
      : [];

    for (const attribute of attributes) {
      if (!attribute || typeof attribute !== "object") continue;

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

      if (attributeName.toUpperCase() !== "CANREDEEM") continue;

      return (
        normalizeBooleanValue(attributeRecord.attributeValue) ??
        normalizeBooleanValue(attributeRecord.value)
      );
    }
  }

  return undefined;
}

function extractPersonDetailsFromQivos(person: Record<string, unknown>): {
  firstName?: string;
  lastName?: string;
  email?: string;
} {
  const firstName = extractStringValue(person.firstName);
  const lastName = extractStringValue(person.lastName);

  let email: string | undefined;
  if (Array.isArray(person.emailList)) {
    for (const emailItem of person.emailList) {
      const record = extractObjectRecord(emailItem);
      if (record) {
        const itemEmail = extractStringValue(
          record.emailAddress ?? record.email,
        );
        if (itemEmail) {
          email = itemEmail;
          break;
        }
      }
    }
  }

  if (!email && Array.isArray(person.telephoneList)) {
    email = extractStringValue(person.email);
  }

  return { firstName, lastName, email };
}

function hasAllPersonDetails(details: {
  firstName?: string;
  lastName?: string;
  email?: string;
}): boolean {
  return !!(details.firstName && details.lastName && details.email);
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : null;
  }
}

function qivosSearchHasResults(responseData: unknown): boolean {
  if (!responseData || typeof responseData !== "object") return false;
  const payload = (responseData as { payload?: { data?: unknown } }).payload;
  return Array.isArray(payload?.data) && payload.data.length > 0;
}

function normalizeInactiveValue(value: unknown): boolean {
  if (typeof value === "boolean") return value === false;
  if (typeof value === "string") return value.trim().toLowerCase() === "false";
  if (value && typeof value === "object" && "value" in value) {
    return normalizeInactiveValue((value as { value?: unknown }).value);
  }
  return false;
}

function extractPersonQCCode(
  person: Record<string, unknown>,
): string | undefined {
  return (
    extractStringValue(person.QCCode) ??
    extractStringValue(person.qcCode) ??
    extractStringValue(person.personQCCode)
  );
}

function extractLoyaltyQCCode(value: unknown): string | undefined {
  const record = extractObjectRecord(value);
  if (!record) return undefined;

  return (
    extractStringValue(record.QCCode) ??
    extractStringValue(record.qcCode) ??
    extractStringValue(record.loyaltyQCCode) ??
    extractStringValue(record.loyaltyCode) ??
    extractStringValue(record.membershipQCCode) ??
    extractStringValue(record.membershipCode) ??
    extractStringValue(record.code)
  );
}

function extractQivosPersons(
  responseData: unknown,
): Record<string, unknown>[] {
  const root = extractObjectRecord(responseData);
  const payload = extractObjectRecord(root?.payload);

  if (Array.isArray(payload?.data)) {
    return (payload.data as unknown[])
      .map((item) => extractObjectRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  if (payload?.data && typeof payload.data === "object") {
    const item = extractObjectRecord(payload.data);
    return item ? [item] : [];
  }

  if (Array.isArray(responseData)) {
    return responseData
      .map((item) => extractObjectRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  return root ? [root] : [];
}

function collectInactiveLoyaltyMemberships(
  person: Record<string, unknown>,
): Array<{ personQCCode: string; loyaltyQCCode: string }> {
  const personQCCode = extractPersonQCCode(person);
  if (!personQCCode) return [];

  const memberships = Array.isArray(person.loyaltyMembershipData)
    ? person.loyaltyMembershipData
    : [];

  return memberships.flatMap((membership) => {
    const record = extractObjectRecord(membership);
    if (!record || !normalizeInactiveValue(record.active)) return [];

    const loyaltyQCCode = extractLoyaltyQCCode(record);
    if (!loyaltyQCCode) return [];

    return [{ personQCCode, loyaltyQCCode }];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight QIVOS fetch — point balance + canRedeem + inactive memberships.
// Used when customer is already linked to avoid unnecessary metafield writes.
// Phone-only search — email search disabled.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFreshLoyaltyBalanceFromQivos(params: {
  phone?: string;
  countryCode?: string;
}): Promise<{
  pointBalance?: string;
  canRedeem?: boolean;
  inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>;
}> {
  const TAG = "[fetchFreshLoyaltyBalance]";

  // ── STEP 1: Normalize inputs ──────────────────────────────────────────────
  const phone = params.phone;
  const countryCode = params.countryCode?.trim().toLowerCase() || "in";

  console.log(`${TAG} STEP 1 — normalized params:`, {
    rawPhone: params.phone,
    normalizedPhone: phone,
    countryCode,
  });

  // Guard: phone must be present
  if (!phone) {
    console.warn(`${TAG} STEP 1 — ABORT: no phone available`);
    return { inactiveMemberships: [] };
  }

  // ── STEP 2: Get QIVOS token ───────────────────────────────────────────────
  let token: string;
  try {
    token = await getQIVOSToken();
    console.log(`${TAG} STEP 2 — token fetched OK (length=${token?.length})`);
  } catch (err) {
    console.error(`${TAG} STEP 2 — FAILED to get QIVOS token:`, err);
    return { inactiveMemberships: [] };
  }

  // ── STEP 3: Build + log request payload ──────────────────────────────────
  const payload: QivosSearchPayload = {
    criteriaList: [
      {
        criteriaType: "TELEPHONE",
        countryCode,
        telephoneNumber: phone,
        telephoneType: "MOBILE",
        isPrimary: true,
      },
    ],
    pagination: { page: 1, pageSize: 10 },
    sorting: { sortingField: "ID", sortingOrder: "DESC" },
  };

  console.log(`${TAG} STEP 3 — request payload:`, JSON.stringify(payload));

  // ── STEP 4: HTTP call ─────────────────────────────────────────────────────
  let response: Response;
  try {
    response = await fetch(QIVOS_PERSONS_SEARCH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-jwt-token": token,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`${TAG} STEP 4 — fetch() threw (network error?):`, err);
    return { inactiveMemberships: [] };
  }

  console.log(`${TAG} STEP 4 — HTTP status: ${response.status}`);

  // ── STEP 5: Read + parse response body ───────────────────────────────────
  let rawText: string;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error(`${TAG} STEP 5 — failed to read response body:`, err);
    return { inactiveMemberships: [] };
  }

  console.log(
    `${TAG} STEP 5 — raw response (first 500 chars):`,
    rawText.slice(0, 500),
  );

  if (!response.ok) {
    console.warn(
      `${TAG} STEP 5 — ABORT: non-OK status ${response.status}, body=${rawText.slice(0, 200)}`,
    );
    return { inactiveMemberships: [] };
  }

  const responseData = parseJsonSafely(rawText);
  console.log(`${TAG} STEP 5 — parsed responseData type:`, typeof responseData);

  // ── STEP 6: Validate shape ────────────────────────────────────────────────
  const hasResults = qivosSearchHasResults(responseData);
  console.log(`${TAG} STEP 6 — qivosSearchHasResults:`, hasResults);

  if (!hasResults) {
    const debugPayload = (responseData as { payload?: { data?: unknown } })
      ?.payload;
    console.warn(`${TAG} STEP 6 — ABORT: no results. payload shape:`, {
      hasPayload: !!debugPayload,
      dataIsArray: Array.isArray(debugPayload?.data),
      dataLength: Array.isArray(debugPayload?.data)
        ? debugPayload.data.length
        : "N/A",
      rawPayloadKeys:
        debugPayload && typeof debugPayload === "object"
          ? Object.keys(debugPayload)
          : [],
    });
    return { inactiveMemberships: [] };
  }

  // ── STEP 7: Extract persons ───────────────────────────────────────────────
  const persons = extractQivosPersons(responseData);
  console.log(`${TAG} STEP 7 — extracted ${persons.length} person(s)`);

  // ── STEP 8: Pull pointBalance + canRedeem + inactiveMemberships ───────────
  let pointBalance: string | undefined;
  let canRedeem: boolean | undefined;
  const inactiveMemberships: Array<{
    personQCCode: string;
    loyaltyQCCode: string;
  }> = [];

  for (const [i, person] of persons.entries()) {
    const pb = extractPointBalanceFromPerson(person);
    const cr = extractCanRedeemFromPerson(person);
    const inactive = collectInactiveLoyaltyMemberships(person);

    console.log(`${TAG} STEP 8 — person[${i}]:`, {
      hasLoyaltyMembershipData: Array.isArray(
        (person as { loyaltyMembershipData?: unknown }).loyaltyMembershipData,
      ),
      membershipCount: Array.isArray(
        (person as { loyaltyMembershipData?: unknown }).loyaltyMembershipData,
      )
        ? (
            person as {
              loyaltyMembershipData: unknown[];
            }
          ).loyaltyMembershipData.length
        : 0,
      extractedPointBalance: pb,
      extractedCanRedeem: cr,
      inactiveMembershipsFound: inactive.length,
    });

    if (pointBalance === undefined) pointBalance = pb;
    if (cr !== undefined) canRedeem = canRedeem === true ? true : cr;
    inactiveMemberships.push(...inactive);
  }

  console.log(`${TAG} STEP 8 — FINAL result:`, {
    pointBalance,
    canRedeem,
    inactiveMemberships,
  });
  return { pointBalance, canRedeem, inactiveMemberships };
}

async function syncCustomerFromQivosSearch(params: {
  request: Request;
  shop: string;
  customerId: string;
  metafields: CustomerIdentitySnapshot;
  allowQivosBackfill: boolean;
}): Promise<{
  synced: boolean;
  inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>;
  backfillApplied: boolean;
  backfillRequired: boolean;
  qivosSearchPerformed: boolean;
  pointBalance?: string;
  canRedeem?: boolean;
  personDetailsMissing?: boolean;
}> {
  const { request, shop, customerId, metafields, allowQivosBackfill } = params;
  const phone = normalizePhoneForQivos(metafields.phone);

  // Phone is required — email fallback removed
  if (!phone) {
    return {
      synced: false,
      inactiveMemberships: [],
      backfillApplied: false,
      backfillRequired: false,
      qivosSearchPerformed: false,
      personDetailsMissing: false,
    };
  }

  const token = await getQIVOSToken();

  const payload: QivosSearchPayload = {
    criteriaList: [
      {
        criteriaType: "TELEPHONE",
        countryCode: metafields.countryCode?.trim().toLowerCase() || "in",
        telephoneNumber: phone,
        telephoneType: "MOBILE",
        isPrimary: true,
      },
    ],
    pagination: { page: 1, pageSize: 10 },
    sorting: { sortingField: "ID", sortingOrder: "DESC" },
  };

  const response = await fetch(QIVOS_PERSONS_SEARCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-jwt-token": token,
    },
    body: JSON.stringify(payload),
  });

  const responseData = parseJsonSafely(await response.text());
  if (!response.ok || !qivosSearchHasResults(responseData)) {
    return {
      synced: false,
      inactiveMemberships: [],
      backfillApplied: false,
      backfillRequired: false,
      qivosSearchPerformed: true,
      personDetailsMissing: false,
    };
  }

  const qivosPersons = extractQivosPersons(responseData);
  const inactiveMemberships = qivosPersons.flatMap((person) =>
    collectInactiveLoyaltyMemberships(person),
  );

  let pointBalance: string | undefined;
  let canRedeem: boolean | undefined;
  let personDetailsMissing = false;

  for (const person of qivosPersons) {
    if (pointBalance === undefined) {
      pointBalance = extractPointBalanceFromPerson(person);
    }

    const personCanRedeem = extractCanRedeemFromPerson(person);
    if (personCanRedeem !== undefined) {
      canRedeem = canRedeem === true ? true : personCanRedeem;
    }

    if (!personDetailsMissing) {
      const personDetails = extractPersonDetailsFromQivos(person);
      if (!hasAllPersonDetails(personDetails)) {
        personDetailsMissing = true;
      }
    }

    if (
      pointBalance !== undefined &&
      canRedeem !== undefined &&
      personDetailsMissing
    )
      break;
  }

  let shopifyProfile = null;
  try {
    shopifyProfile = await fetchShopifyCustomerProfile({ shop, customerId });
  } catch (error) {
    console.warn("[QIVOS] Failed to load Shopify profile for person backfill:", {
      customerId,
      error,
    });
  }

  const backfillRequired = qivosPersons.some((person) =>
    qivosPersonNeedsShopifyProfileBackfill({
      person,
      profile: shopifyProfile,
    }),
  );

  const backfillResults = allowQivosBackfill
    ? await Promise.all(
        qivosPersons.map((person) =>
          backfillMissingQivosPersonDetails({
            shop,
            customerId,
            person,
            profile: shopifyProfile,
          }),
        ),
      )
    : [];

  if (
    backfillResults.some((result) => result.namePatched || result.emailPatched)
  ) {
    console.log(
      "[QIVOS] Backfilled missing person details from Shopify profile:",
      { customerId, results: backfillResults },
    );
  }

  const syncResult = await syncCustomerMetafields(
    request,
    {
      shop,
      customerId,
      email: metafields.email,
      phone: metafields.phone,
      countryCode: metafields.countryCode,
      loyaltySync: true,
    },
    responseData,
  );

  return {
    synced: syncResult.synced === true,
    inactiveMemberships,
    backfillApplied: backfillResults.some(
      (result) => result.namePatched || result.emailPatched,
    ),
    backfillRequired,
    qivosSearchPerformed: true,
    pointBalance,
    canRedeem,
    personDetailsMissing,
  };
}

function extractShopFromDest(dest: string | undefined): string | undefined {
  if (!dest) return undefined;
  try {
    return normalizeShopDomain(new URL(dest).host);
  } catch {
    return normalizeShopDomain(dest);
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request.headers.get("Origin"), "GET, OPTIONS"),
    });
  }

  const { cors, sessionToken } =
    await authenticate.public.customerAccount(request);

  const url = new URL(request.url);
  const requestedCustomerId = url.searchParams.get("customerId");
  const allowQivosBackfill =
    url.searchParams.get("allowQivosBackfill") === "1";
  const tokenCustomerId =
    typeof sessionToken.sub === "string"
      ? toShopifyCustomerGid(sessionToken.sub)
      : undefined;
  const customerId =
    tokenCustomerId ?? toShopifyCustomerGid(requestedCustomerId);
  const shop = extractShopFromDest(
    typeof sessionToken.dest === "string" ? sessionToken.dest : undefined,
  );

  if (!shop || !customerId) {
    return cors(
      new Response(
        JSON.stringify({
          ok: false,
          error: "Missing authenticated shop or customer id",
          debug: {
            shop,
            customerId,
            tokenSub: sessionToken.sub ?? null,
            tokenDest: sessionToken.dest ?? null,
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  try {
    let metafields = await getCustomerIdentityMetafields({ shop, customerId });

    const alreadyLinked =
      metafields.loyaltySync === true &&
      !!metafields.personQCCode &&
      !!metafields.loyaltyQCCode &&
      !!metafields.phone;

    let qivosSearchResult: {
      synced: boolean;
      inactiveMemberships: Array<{
        personQCCode: string;
        loyaltyQCCode: string;
      }>;
      backfillApplied: boolean;
      backfillRequired: boolean;
      qivosSearchPerformed: boolean;
      pointBalance?: string;
      canRedeem?: boolean;
      personDetailsMissing?: boolean;
    };

    if (alreadyLinked && !allowQivosBackfill) {
      // Customer already linked — fetch ONLY balance/canRedeem from QIVOS.
      // Phone-only search — email removed.
      const freshBalance = await fetchFreshLoyaltyBalanceFromQivos({
        phone: metafields.phone,
        countryCode: metafields.countryCode,
      }).catch((err) => {
        console.warn("[QIVOS] fetchFreshLoyaltyBalance failed:", err);
        return {};
      });

      qivosSearchResult = {
        synced: false,
        inactiveMemberships: freshBalance.inactiveMemberships ?? [],
        backfillApplied: false,
        backfillRequired: false,
        qivosSearchPerformed: true,
        pointBalance: freshBalance.pointBalance,
        canRedeem: freshBalance.canRedeem,
        personDetailsMissing: false,
      };
    } else {
      qivosSearchResult = await syncCustomerFromQivosSearch({
        request,
        shop,
        customerId,
        metafields,
        allowQivosBackfill,
      });
    }

    const qivosSyncApplied = qivosSearchResult.synced;

    if (qivosSyncApplied) {
      metafields = await getCustomerIdentityMetafields({ shop, customerId });
    }

    const [availableCountries, loyaltyData] = await Promise.all([
      fetchShopCountries(shop),
      Promise.resolve(
        qivosSearchResult.qivosSearchPerformed
          ? {
              pointBalance: qivosSearchResult.pointBalance,
              canRedeem: qivosSearchResult.canRedeem,
            }
          : {
              pointBalance: metafields.redeemPoint,
              canRedeem: metafields.canRedeem,
            },
      ),
    ]);

    const freshPointBalance = loyaltyData.pointBalance;
    const freshCanRedeem =
      loyaltyData.canRedeem ?? metafields.canRedeem ?? false;

    // Prefer freshPointBalance from QIVOS as source of truth;
    // fall back to stored only if QIVOS returned nothing (e.g. network error).
    const redeemPoint = freshPointBalance ?? metafields.redeemPoint;

    const pointBalanceChanged =
      freshPointBalance !== undefined &&
      freshPointBalance !== metafields.redeemPoint;

    const canRedeemChanged = freshCanRedeem !== (metafields.canRedeem ?? false);

    const shouldUpdateMetafields = pointBalanceChanged || canRedeemChanged;

    console.log("[LOYALTY] Balance check:", {
      storedRedeemPoint: metafields.redeemPoint,
      freshPointBalance,
      pointBalanceChanged,
      canRedeemChanged,
      shouldUpdateMetafields,
    });

    if (shouldUpdateMetafields) {
      try {
        await saveCustomerIdentityMetafields({
          shop,
          customerId,
          values: {
            redeemPoint,
            canRedeem: freshCanRedeem,
          },
        });
      } catch (error) {
        console.warn("Failed to save loyalty metafields:", error);
      }
    }

    const shopCountryCode = availableCountries[0]?.code;

    // Credit store balance only when:
    // 1. canRedeem is true
    // 2. We have a fresh point balance
    // 3. The balance actually changed from what's stored
    if (freshCanRedeem === true && freshPointBalance && pointBalanceChanged) {
      try {
        const redeemPoints = Number(freshPointBalance);
        if (!Number.isFinite(redeemPoints) || redeemPoints <= 0) {
          throw new Error(
            `Invalid redeem points value: ${freshPointBalance}`,
          );
        }

        await creditCustomerStoreCredit({
          shop,
          customerId,
          redeemPoints,
        });
      } catch (error) {
        console.warn("Failed to credit customer store balance:", error);
      }
    }

    return cors(
      new Response(
        JSON.stringify({
          ok: true,
          shop,
          customerId,
          ...metafields,
          availableCountries,
          shopCountryCode,
          pointBalance: redeemPoint,
          redeemPoint,
          canRedeem: freshCanRedeem,
          qivosSyncApplied,
          qivosBackfillApplied: qivosSearchResult.backfillApplied,
          qivosBackfillRequired: qivosSearchResult.backfillRequired,
          qivosPersonDetailsMissing: qivosSearchResult.personDetailsMissing,
          inactiveMemberships: qivosSearchResult.inactiveMemberships,
          needsActivation: qivosSearchResult.inactiveMemberships.length > 0,
          debug: {
            tokenSub: sessionToken.sub ?? null,
            tokenDest: sessionToken.dest ?? null,
            availableCountries,
            shopCountryCode: shopCountryCode ?? null,
            pointBalanceChanged,
            canRedeemChanged,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load customer metafields";

    return cors(
      new Response(
        JSON.stringify({
          ok: false,
          error: message,
          debug: {
            shop,
            customerId,
            tokenSub: sessionToken.sub ?? null,
            tokenDest: sessionToken.dest ?? null,
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }
};

/**
 * Action handler to save/update customer metafields (POST request)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Method ${request.method} not allowed. Use POST.`,
      }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const { cors, sessionToken } =
    await authenticate.public.customerAccount(request);

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch (error) {
    return cors(
      new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  const shop = extractShopFromDest(
    typeof sessionToken.dest === "string" ? sessionToken.dest : undefined,
  );
  const customerId = body.customerId
    ? toShopifyCustomerGid(String(body.customerId))
    : typeof sessionToken.sub === "string"
      ? toShopifyCustomerGid(sessionToken.sub)
      : undefined;

  if (!shop || !customerId) {
    return cors(
      new Response(
        JSON.stringify({
          ok: false,
          error: "Missing authenticated shop or customer id",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  try {
    const metafieldValues: Record<string, unknown> = {};
    const fieldMappings: Record<string, string> = {
      email: "email",
      phone: "phone",
      countryCode: "countryCode",
      firstName: "firstName",
      lastName: "lastName",
      personQCCode: "personQCCode",
      loyaltyQCCode: "loyaltyQCCode",
      pointBalance: "pointBalance",
      redeemPoint: "redeemPoint",
      canRedeem: "canRedeem",
      tier: "tier",
      loyaltySync: "loyaltySync",
    };

    for (const [key, value] of Object.entries(body)) {
      if (fieldMappings[key] && value !== undefined && value !== null) {
        metafieldValues[fieldMappings[key]] = value;
      }
    }

    await saveCustomerIdentityMetafields({
      shop,
      customerId,
      values: metafieldValues,
    });

    const updatedMetafields = await getCustomerIdentityMetafields({
      shop,
      customerId,
    });

    return cors(
      new Response(
        JSON.stringify({
          ok: true,
          message: "Metafields saved successfully",
          customerId,
          shop,
          ...updatedMetafields,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to save customer metafields";

    console.error("Error saving metafields:", error);

    return cors(
      new Response(
        JSON.stringify({ ok: false, error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
};
