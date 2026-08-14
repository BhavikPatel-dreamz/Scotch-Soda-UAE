import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getCustomerIdentityMetafields,
  saveCustomerIdentityMetafields,
  syncCustomerMetafields,
} from "../utils/shopify-customer-metafields.server";
import {
  normalizeShopDomain,
  toShopifyCustomerGid,
} from "../utils/store.server";
import { getAdminGraphqlClient } from "../utils/shopify-admin.server";
import { CORS_HEADERS } from "../utils/cors.server";
import { getQIVOSToken } from "../utils/qivos-token.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../utils/constants";
import {
  backfillMissingQivosPersonDetails,
  fetchShopifyCustomerProfile,
  qivosPersonNeedsShopifyProfileBackfill,
} from "../utils/qivos-person-backfill.server";
import {
  collectInactiveLoyaltyMemberships,
} from "../utils/customer-account-loyalty.server";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js";

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

function normalizePhoneForQivos(
  phone: string | undefined,
  countryCode?: string,
): string | undefined {
  if (!phone) return undefined;

  // The stored metafield is usually a national number (e.g. "562150685" for AE),
  // which libphonenumber cannot parse without a region hint. Always pass the
  // saved country so 9-digit AE/SA numbers resolve instead of being dropped.
  const region = countryCode?.trim().toUpperCase();
  const parsedPhone =
    (region ? parsePhoneNumberFromString(phone, region as CountryCode) : undefined) ??
    parsePhoneNumberFromString(phone);

  if (parsedPhone?.nationalNumber) {
    return String(parsedPhone.nationalNumber);
  }

  const digits = phone.replace(/\D/g, "");
  return digits || undefined;
}

const shopCountriesCache = new Map<string, { code: string; name: string }[]>();

function normalizeCountryEntry(
  codeValue: unknown,
  nameValue: unknown,
): { code: string; name: string } | null {
  const code =
    typeof codeValue === "string"
      ? codeValue.trim().toUpperCase()
      : typeof codeValue === "number"
        ? String(codeValue).trim().toUpperCase()
        : "";
  if (!code) return null;

  const name =
    typeof nameValue === "string"
      ? nameValue.trim()
      : typeof nameValue === "number"
        ? String(nameValue).trim()
        : "";

  return { code, name: name || code };
}

function collectCountryEntries(value: unknown, results: { code: string; name: string }[]) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCountryEntries(item, results);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const directCountry = normalizeCountryEntry(
    record.countryCode ?? record.code ?? record.isoCode,
    record.name ?? record.label,
  );
  if (directCountry) {
    results.push(directCountry);
  }

  for (const nestedValue of Object.values(record)) {
    collectCountryEntries(nestedValue, results);
  }
}

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
                  code
                  name
                }
              }
            }
          }
        }
      }
    `);

    const body = await response.json();

    const rawCountries: { code: string; name: string }[] = [];
    collectCountryEntries(body?.data, rawCountries);

    const seen = new Set<string>();
    const countries = rawCountries.filter((country) => {
      if (!country?.code || seen.has(country.code)) return false;
      seen.add(country.code);
      return true;
    });

    console.log(
      `[fetchShopCountries] shop=${shop} — found ${countries.length} unique countries`
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

function extractObjectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function normalizeBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (value && typeof value === "object" && "value" in value) {
    return normalizeBooleanValue((value as { value?: unknown }).value);
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

function extractFirstMembershipCategory(person: unknown): string | undefined {
  if (!person || typeof person !== "object") return undefined;

  const loyaltyMembershipData = (person as { loyaltyMembershipData?: unknown })
    .loyaltyMembershipData;

  if (!Array.isArray(loyaltyMembershipData) || loyaltyMembershipData.length === 0) {
    return undefined;
  }

  const firstMembership = loyaltyMembershipData[0];
  if (!firstMembership || typeof firstMembership !== "object") {
    return undefined;
  }

  const record = firstMembership as Record<string, unknown>;
  return (
    extractStringValue(record.category) ??
    extractStringValue(record.tier) ??
    extractStringValue(record.tierName) ??
    extractStringValue(record.membershipTier)
  );
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

async function fetchFreshLoyaltyBalanceFromQivos(params: {
  phone?: string;
  countryCode?: string;
}): Promise<{
  pointBalance?: string;
  canRedeem?: boolean;
  tier?: string;
  inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>;
}> {
  const TAG = "[fetchFreshLoyaltyBalance]";

  const phone = params.phone;
  const countryCode = params.countryCode?.trim().toLowerCase() || "in";

  console.log(`${TAG} STEP 1 — normalized params:`, {
    rawPhone: params.phone,
    normalizedPhone: phone,
    countryCode,
  });

  if (!phone) {
    console.warn(`${TAG} STEP 1 — ABORT: no phone available`);
    return { inactiveMemberships: [] };
  }

  let token: string;
  try {
    token = await getQIVOSToken();
    console.log(`${TAG} STEP 2 — token fetched OK (length=${token?.length})`);
  } catch (err) {
    console.error(`${TAG} STEP 2 — FAILED to get QIVOS token:`, err);
    return { inactiveMemberships: [] };
  }

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
  const hasResults = qivosSearchHasResults(responseData);

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

  const persons = extractQivosPersons(responseData);
  console.log(`${TAG} STEP 7 — extracted ${persons.length} person(s)`);

  let pointBalance: string | undefined;
  let canRedeem: boolean | undefined;
  let tier: string | undefined;
  const inactiveMemberships: Array<{
    personQCCode: string;
    loyaltyQCCode: string;
  }> = [];

  for (const [i, person] of persons.entries()) {
    const pb = extractPointBalanceFromPerson(person);
    const cr = extractCanRedeemFromPerson(person);
    const categoryTier = extractFirstMembershipCategory(person);
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
    if (tier === undefined && categoryTier) tier = categoryTier;
    inactiveMemberships.push(...inactive);
  }

  console.log(`${TAG} STEP 8 — FINAL result:`, {
    pointBalance,
    canRedeem,
    tier,
    inactiveMemberships,
  });
  return { pointBalance, canRedeem, tier, inactiveMemberships };
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
  const phone = normalizePhoneForQivos(metafields.phone, metafields.countryCode);

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
        countryCode: metafields.countryCode?.trim().toLowerCase() || "ae",
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared response builder — used by both quickLoad and full loader paths.
// ─────────────────────────────────────────────────────────────────────────────
function buildSuccessResponse(params: {
  shop: string;
  customerId: string;
  metafields: CustomerIdentitySnapshot;
  availableCountries: { code: string; name: string }[];
  redeemPoint: string | undefined;
  canRedeem: boolean;
  qivosSyncApplied: boolean;
  inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>;
  backfillApplied: boolean;
  backfillRequired: boolean;
  personDetailsMissing: boolean | undefined;
  pointBalanceChanged: boolean;
  canRedeemChanged: boolean;
  sessionToken: { sub?: unknown; dest?: unknown };
  quickLoad?: boolean;
}) {
  const shopCountryCode = params.availableCountries[0]?.code;
  return JSON.stringify({
    ok: true,
    shop: params.shop,
    customerId: params.customerId,
    ...params.metafields,
    availableCountries: params.availableCountries,
    shopCountryCode,
    pointBalance: params.redeemPoint,
    redeemPoint: params.redeemPoint,
    canRedeem: params.canRedeem,
    qivosSyncApplied: params.qivosSyncApplied,
    qivosBackfillApplied: params.backfillApplied,
    qivosBackfillRequired: params.backfillRequired,
    qivosPersonDetailsMissing: params.personDetailsMissing,
    inactiveMemberships: params.inactiveMemberships,
    needsActivation: params.inactiveMemberships.length > 0,
    debug: {
      quickLoad: params.quickLoad ?? false,
      tokenSub: params.sessionToken.sub ?? null,
      tokenDest: params.sessionToken.dest ?? null,
      availableCountries: params.availableCountries,
      shopCountryCode: shopCountryCode ?? null,
      pointBalanceChanged: params.pointBalanceChanged,
      canRedeemChanged: params.canRedeemChanged,
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { cors, sessionToken } =
    await authenticate.public.customerAccount(request);

  const url = new URL(request.url);
  const requestedCustomerId = url.searchParams.get("customerId");
  const allowQivosBackfill =
    url.searchParams.get("allowQivosBackfill") === "1";

  // ── NEW: quickLoad param — return DB-only data immediately, skip QIVOS ──
  // allowQivosBackfill always wins: the caller explicitly asked for the QIVOS
  // round-trip that patches missing person details, and the quickLoad fast path
  // returns before any of that runs.
  const quickLoad =
    url.searchParams.get("quickLoad") === "1" && !allowQivosBackfill;

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
    // ── FAST PATH: quickLoad=1 — return stored metafields immediately ────────
    // Fires DB read + fetchShopCountries in parallel. No QIVOS call at all.
    // The extension calls this first so UI renders instantly, then calls again
    // without quickLoad in the background to get fresh QIVOS data.
    if (quickLoad) {
      const [metafields, availableCountries] = await Promise.all([
        getCustomerIdentityMetafields({ shop, customerId }),
        fetchShopCountries(shop),
      ]);

      const redeemPoint = metafields.redeemPoint;
      const canRedeem = metafields.canRedeem ?? false;

      return cors(
        new Response(
          buildSuccessResponse({
            shop,
            customerId,
            metafields,
            availableCountries,
            redeemPoint,
            canRedeem,
            qivosSyncApplied: false,
            inactiveMemberships: [],
            backfillApplied: false,
            backfillRequired: false,
            personDetailsMissing: false,
            pointBalanceChanged: false,
            canRedeemChanged: false,
            sessionToken,
            quickLoad: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // ── FULL PATH: fetch metafields + fire countriesPromise early ────────────
    // fetchShopCountries starts immediately — it runs in parallel with QIVOS.
    const countriesPromise = fetchShopCountries(shop);

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
      tier?: string;
      personDetailsMissing?: boolean;
    };

    if (alreadyLinked && !allowQivosBackfill) {
      // Customer already linked — fetch ONLY balance/canRedeem from QIVOS.
      const freshBalance = await fetchFreshLoyaltyBalanceFromQivos({
        phone: normalizePhoneForQivos(metafields.phone, metafields.countryCode),
        countryCode: metafields.countryCode,
      }).catch((err): {
        pointBalance?: string;
        canRedeem?: boolean;
        tier?: string;
        inactiveMemberships: Array<{ personQCCode: string; loyaltyQCCode: string }>;
      } => {
        console.warn("[QIVOS] fetchFreshLoyaltyBalance failed:", err);
        return { inactiveMemberships: [] };
      });

      qivosSearchResult = {
        synced: false,
        inactiveMemberships: freshBalance.inactiveMemberships ?? [],
        backfillApplied: false,
        backfillRequired: false,
        qivosSearchPerformed: true,
        pointBalance: freshBalance.pointBalance,
        canRedeem: freshBalance.canRedeem,
        tier: freshBalance.tier,
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

    // ── Await countriesPromise here — it has been running in parallel ────────
    const [availableCountries, loyaltyData] = await Promise.all([
      countriesPromise,
      Promise.resolve(
        qivosSearchResult.qivosSearchPerformed
          ? {
              pointBalance: qivosSearchResult.pointBalance,
              canRedeem: qivosSearchResult.canRedeem,
              tier: qivosSearchResult.tier,
            }
          : {
              pointBalance: metafields.redeemPoint,
              canRedeem: metafields.canRedeem,
              tier: metafields.tier,
            },
      ),
    ]);

    const freshPointBalance = loyaltyData.pointBalance;
    const freshCanRedeem =
      loyaltyData.canRedeem ?? metafields.canRedeem ?? false;
    const freshTier = loyaltyData.tier ?? metafields.tier;

    let redeemPoint = freshPointBalance ?? metafields.redeemPoint;

    const pointBalanceChanged =
      freshPointBalance !== undefined &&
      freshPointBalance !== metafields.redeemPoint;

    const canRedeemChanged = freshCanRedeem !== (metafields.canRedeem ?? false);

    const tierChanged =
      freshTier !== undefined && freshTier !== metafields.tier;
    const shouldUpdateMetafields =
      pointBalanceChanged || canRedeemChanged || tierChanged;

    console.log("[LOYALTY] Balance check:", {
      storedRedeemPoint: metafields.redeemPoint,
      freshPointBalance,
      pointBalanceChanged,
      canRedeemChanged,
      shouldUpdateMetafields,
    });

    let loyaltyMetafieldsSaved = false;

    // If we have a fresh point balance and it doesn't match stored value,
    // persist it immediately so DB reflects the latest balance.
    if (tierChanged && freshTier) {
      try {
        await saveCustomerIdentityMetafields({
          shop,
          customerId,
          values: {
            tier: freshTier,
          },
        });
        metafields = { ...metafields, tier: freshTier };
      } catch (error) {
        console.warn("Failed to save tier metafield:", error);
      }
    }

    if (
      freshPointBalance !== undefined &&
      freshPointBalance !== metafields.redeemPoint
    ) {
      try {
        await saveCustomerIdentityMetafields({
          shop,
          customerId,
          values: {
            redeemPoint: String(freshPointBalance),
            canRedeem: freshCanRedeem,
          },
        });
        loyaltyMetafieldsSaved = true;
        redeemPoint = String(freshPointBalance);
      } catch (error) {
        console.warn("Failed to save immediate loyalty metafields:", error);
      }
    }

    if (shouldUpdateMetafields && !loyaltyMetafieldsSaved) {
      try {
        await saveCustomerIdentityMetafields({
          shop,
          customerId,
          values: {
            redeemPoint,
            canRedeem: freshCanRedeem,
          },
        });
        loyaltyMetafieldsSaved = true;
      } catch (error) {
        console.warn("Failed to save loyalty metafields:", error);
      }
    }

    return cors(
      new Response(
        buildSuccessResponse({
          shop,
          customerId,
          metafields,
          availableCountries,
          redeemPoint,
          canRedeem: freshCanRedeem,
          qivosSyncApplied,
          inactiveMemberships: qivosSearchResult.inactiveMemberships,
          backfillApplied: qivosSearchResult.backfillApplied,
          backfillRequired: qivosSearchResult.backfillRequired,
          personDetailsMissing: qivosSearchResult.personDetailsMissing,
          pointBalanceChanged,
          canRedeemChanged,
          sessionToken,
          quickLoad: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
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
      phone: "phone",
      countryCode: "countryCode",
      personQCCode: "personQCCode",
      loyaltyQCCode: "loyaltyQCCode",
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
