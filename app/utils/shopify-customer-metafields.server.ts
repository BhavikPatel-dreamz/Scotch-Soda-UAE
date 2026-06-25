import { resolveCurrentShop, toShopifyCustomerGid } from "./store.server";
import {
  getAdminGraphqlClient,
  type AdminGraphqlClient,
} from "./shopify-admin.server";
import {
  findFirstNestedValue,
  normalizeBooleanValue
} from "./qivos-utils.server";

const DEFAULT_METAFIELD_NAMESPACE = "custom";

export type CustomerSyncBody = {
  email?: string;
  phone?: string;
  telephoneList?: unknown[];
  emailList?: unknown[];
  addressList?: unknown[];
  billingAddress?: unknown;
  shippingAddress?: unknown;
  loyaltyMembershipData?: unknown[];
  customerId?: string | number;
  shop?: string;
  metafieldNamespace?: string;
  qivos?: string;
  [key: string]: unknown;
};

export type CustomerIdentityMetafieldValues = {
  personQCCode?: string;
  loyaltyQCCode?: string;
  countryCode?: string;
  phone?: string;
  email?: string;
  tier?: string;
  redeemPoint?: string;
  canRedeem?: boolean;
  loyaltySync?: boolean;
  qivos?: string;
  qivosNote?: string;
};

export type SaveCustomerMetafieldsResult = {
  addedKeys: string[];
  skippedReason?: string;
  shopAuthenticated: boolean;
  savedValues: CustomerIdentityMetafieldValues;
};

export type CustomerMetafieldSyncResult = {
  synced: boolean;
  customerId?: string;
  shop?: string;
  email?: string;
  customerCreated?: boolean;
  addedKeys?: string[];
  skippedReason?: string;
  shopAuthenticated?: boolean;
  savedValues?: CustomerIdentityMetafieldValues;
};

type ShopifyCustomerNode = {
  id: string;
};

type CustomersByMetafieldData = {
  customers?: {
    edges?: Array<{
      node?: {
        id?: string;
      };
    }>;
  };
};

type ShopifyMailingAddressInput = {
  address1?: string;
  address2?: string;
  city?: string;
  company?: string;
  countryCode?: string;
  phone?: string;
  provinceCode?: string;
  zip?: string;
};

type CustomerProfile = {
  email?: string;
  phone?: string;
  addressList?: unknown[];
  billingAddress?: unknown;
  shippingAddress?: unknown;
};

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
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

function extractFirstFromArrayField(
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

// function findFirstNestedValue(
//   value: unknown,
//   candidateKeys: string[],
// ): string | undefined {
//   if (Array.isArray(value)) {
//     for (const item of value) {
//       const nested = findFirstNestedValue(item, candidateKeys);
//       if (nested) {
//         return nested;
//       }
//     }
//     return undefined;
//   }

//   const record = extractObjectRecord(value);
//   if (!record) {
//     return undefined;
//   }

//   for (const key of candidateKeys) {
//     const directValue = extractStringValue(record[key]);
//     if (directValue) {
//       return directValue;
//     }
//   }

//   for (const nestedValue of Object.values(record)) {
//     const nested = findFirstNestedValue(nestedValue, candidateKeys);
//     if (nested) {
//       return nested;
//     }
//   }

//   return undefined;
// }

export async function ensureMetafieldDefinitions(
  adminClient: AdminGraphqlClient,
  namespace: string,
): Promise<void> {
  const definitions = [
    { name: "Person QC Code", key: "person_qc_code" },
    { name: "Loyalty QC Code", key: "loyalty_qc_code" },
    { name: "Country Code", key: "country_code" },
    { name: "Phone", key: "phone" },
    { name: "Tier", key: "tier" },
    { name: "Redeem Point", key: "redeem_point" },
    { name: "Can Redeem", key: "can_redeem", type: "boolean" },
    { name: "Loyalty Sync", key: "loyalty_sync", type: "boolean" },
    { name: "Qivos", key: "qivos" },
    { name: "QIVOS Note", key: "qivos_note" },
  ];

  for (const def of definitions) {
    const response = await adminClient.graphql(
      `#graphql
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { code message }
          }
        }
      `,
      {
        variables: {
          definition: {
            name: def.name,
            namespace,
            key: def.key,
            type: def.type ?? "single_line_text_field",
            ownerType: "CUSTOMER",
          },
        },
      },
    );

    const result = (await response.json()) as {
      data?: {
        metafieldDefinitionCreate?: {
          userErrors?: Array<{ code?: string; message?: string }>;
        };
      };
    };

    const errors = result.data?.metafieldDefinitionCreate?.userErrors ?? [];

    // TAKEN means definition already exists — that's fine, skip it
    const hasRealError = errors.some((e) => e.code !== "TAKEN");
    if (hasRealError) {
      console.warn("Metafield definition error:", errors);
    }
  }
}

function normalizeCountryCode(value: unknown): string | undefined {
  const countryCode = extractStringValue(value);
  return countryCode ? countryCode.toUpperCase() : undefined;
}

function getDialCodeByCountry(
  countryCode: string | undefined,
): string | undefined {
  switch (countryCode?.toUpperCase()) {
    case "AE":
      return "+971";
    case "SA":
      return "+966";
    case "IN":
      return "+91";
    case "CA":
      return "+1";
    default:
      return undefined;
  }
}

function normalizePhoneForMetafield(
  phone: string | undefined,
  countryCode?: string,
): string | undefined {
  if (!phone) return undefined;

  const digits = phone.replace(/\D/g, "");
  if (!digits) return undefined;

  const dialCode = getDialCodeByCountry(countryCode);
  if (dialCode) {
    const countryDigits = dialCode.replace("+", "");
    if (digits.startsWith(countryDigits)) {
      return digits.slice(countryDigits.length);
    }
  }

  const knownDialCodes = ["971", "966", "91", "1"];
  for (const countryDigits of knownDialCodes) {
    if (digits.startsWith(countryDigits) && digits.length > 10) {
      return digits.slice(countryDigits.length);
    }
  }

  return digits;
}

function getResponseRoots(responseData: unknown): Record<string, unknown>[] {
  const queue: unknown[] = [responseData];
  const roots: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    const record = extractObjectRecord(current);
    if (!record) {
      continue;
    }

    roots.push(record);

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return roots;
}

function extractFirstRecordWithArrays(
  responseData: unknown,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const record of getResponseRoots(responseData)) {
    if (keys.some((key) => Array.isArray(record[key]))) {
      return record;
    }
  }

  return undefined;
}

function extractResponseArrays(responseData: unknown): {
  emailList: unknown;
  loyaltyMembershipData: unknown;
} {
  const record = extractFirstRecordWithArrays(responseData, [
    "emailList",
    "loyaltyMembershipData",
  ]);

  return {
    emailList: record?.emailList,
    loyaltyMembershipData: record?.loyaltyMembershipData,
  };
}

function extractPhoneFromSource(
  source: Record<string, unknown> | undefined,
): string | undefined {
  if (!source) {
    return undefined;
  }

  const directPhone =
    extractStringValue(source.phone) ??
    extractStringValue(source.mobileNumber) ??
    extractStringValue(source.telephoneNumber);
  if (directPhone) {
    return directPhone;
  }

  return (
    extractFirstFromArrayField(source.telephoneList, [
      "telephoneNumber",
      "mobileNumber",
      "phone",
    ]) ??
    findFirstNestedValue(source, ["telephoneNumber", "mobileNumber", "phone"])
  );
}

function extractEmailFromSource(
  source: Record<string, unknown> | undefined,
): string | undefined {
  if (!source) {
    return undefined;
  }

  return (
    extractStringValue(source.email) ??
    extractStringValue(source.emailAddress) ??
    extractFirstFromArrayField(source.emailList, ["emailAddress", "email"]) ??
    findFirstNestedValue(source, ["emailAddress", "email"])
  );
}

function extractAddressArray(
  source: Record<string, unknown> | undefined,
): unknown[] | undefined {
  return Array.isArray(source?.addressList) ? source.addressList : undefined;
}

function buildCustomerProfile(
  body: CustomerSyncBody,
  responseData: unknown,
): CustomerProfile {
  const responseRoots = getResponseRoots(responseData);
  const responseRecordWithAddresses = extractFirstRecordWithArrays(
    responseData,
    ["addressList"],
  );

  return {
    email:
      extractEmailFromSource(body) ??
      responseRoots.map(extractEmailFromSource).find(Boolean),
    phone:
      extractPhoneFromSource(body) ??
      responseRoots.map(extractPhoneFromSource).find(Boolean),
    addressList:
      extractAddressArray(body) ??
      extractAddressArray(responseRecordWithAddresses),
    billingAddress:
      body.billingAddress ??
      responseRoots
        .map((record) => record.billingAddress)
        .find((value) => Boolean(extractObjectRecord(value))),
    shippingAddress:
      body.shippingAddress ??
      responseRoots
        .map((record) => record.shippingAddress)
        .find((value) => Boolean(extractObjectRecord(value))),
  };
}

function buildMailingAddress(
  value: unknown,
  profile: CustomerProfile,
): ShopifyMailingAddressInput | null {
  const record = extractObjectRecord(value);
  if (!record) {
    return null;
  }

  const address = {
    address1:
      extractStringValue(record.address1) ??
      extractStringValue(record.addressLine1) ??
      extractStringValue(record.line1),
    address2:
      extractStringValue(record.address2) ??
      extractStringValue(record.addressLine2) ??
      extractStringValue(record.line2),
    city:
      extractStringValue(record.city) ??
      extractStringValue(record.town) ??
      extractStringValue(record.district),
    company: extractStringValue(record.company),
    countryCode:
      normalizeCountryCode(record.countryCode) ??
      normalizeCountryCode(record.country) ??
      normalizeCountryCode(record.countryIsoCode),
    phone:
      extractStringValue(record.phone) ??
      extractStringValue(record.telephoneNumber) ??
      extractStringValue(profile.phone),
    provinceCode:
      extractStringValue(record.provinceCode) ??
      extractStringValue(record.stateCode) ??
      extractStringValue(record.regionCode),
    zip:
      extractStringValue(record.zip) ??
      extractStringValue(record.postalCode) ??
      extractStringValue(record.zipCode),
  } satisfies ShopifyMailingAddressInput;

  if (Object.values(address).some(Boolean)) {
    return address;
  }

  return null;
}

function extractCustomerAddresses(
  profile: CustomerProfile,
): ShopifyMailingAddressInput[] | undefined {
  const addresses: ShopifyMailingAddressInput[] = [];

  if (Array.isArray(profile.addressList)) {
    for (const item of profile.addressList) {
      const address = buildMailingAddress(item, profile);
      if (address) {
        addresses.push(address);
      }
    }
  }

  const billingAddress = buildMailingAddress(profile.billingAddress, profile);
  if (billingAddress) {
    addresses.push(billingAddress);
  }

  const shippingAddress = buildMailingAddress(profile.shippingAddress, profile);
  if (shippingAddress) {
    addresses.push(shippingAddress);
  }

  return addresses.length > 0 ? addresses : undefined;
}

function extractFirstArrayQCCode(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const record = extractObjectRecord(item);
    if (!record) {
      continue;
    }

    const qcCode =
      extractStringValue(record.QCCode) ??
      extractStringValue(record.qcCode) ??
      extractStringValue(record.loyaltyQCCode) ??
      extractStringValue(record.loyaltyCode) ??
      extractStringValue(record.membershipQCCode) ??
      extractStringValue(record.membershipCode) ??
      extractStringValue(record.code);
    if (qcCode) {
      return qcCode;
    }
  }

  return undefined;
}

function extractTierFromLoyaltyMembershipData(
  value: unknown,
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let fallbackTier: string | undefined;

  for (const item of value) {
    const record = extractObjectRecord(item);
    if (!record) {
      continue;
    }

    const tier =
      extractStringValue(record.category) ?? extractStringValue(record.tier);

    if (!tier) {
      continue;
    }

    if (record.active === false) {
      fallbackTier ??= tier;
      continue;
    }

    return tier;
  }

  return fallbackTier;
}

function extractCanRedeemFromLoyaltyMembershipData(
  value: unknown,
): boolean | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let fallbackCanRedeem: boolean | undefined;

  for (const item of value) {
    const record = extractObjectRecord(item);
    if (!record) {
      continue;
    }

    const attributes = Array.isArray(record.attributes)
      ? record.attributes
      : [];
    for (const attribute of attributes) {
      const attributeRecord = extractObjectRecord(attribute);
      if (!attributeRecord) {
        continue;
      }

      const attributeName =
        extractStringValue(attributeRecord.attributeName) ??
        extractStringValue(attributeRecord.name) ??
        extractStringValue(attributeRecord.attributeKey);

      if (attributeName?.toUpperCase() !== "CANREDEEM") {
        continue;
      }

      const canRedeem =
        normalizeBooleanValue(attributeRecord.attributeValue) ??
        normalizeBooleanValue(attributeRecord.value);

      if (canRedeem === undefined) {
        continue;
      }

      if (record.active === false) {
        fallbackCanRedeem ??= canRedeem;
        continue;
      }

      return canRedeem;
    }
  }

  return fallbackCanRedeem;
}

function extractRedeemPointFromLoyaltyMembershipData(
  value: unknown,
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let fallbackRedeemPoint: string | undefined;

  for (const item of value) {
    const record = extractObjectRecord(item);
    if (!record) {
      continue;
    }

    const redeemPoint =
      extractStringValue(record.pointBalance) ??
      extractStringValue(record.redeemPoint) ??
      extractStringValue(record.redeem_point);

    if (!redeemPoint) {
      continue;
    }

    if (record.active === false) {
      fallbackRedeemPoint ??= redeemPoint;
      continue;
    }

    return redeemPoint;
  }

  return fallbackRedeemPoint;
}

function extractMetafieldValues(
  body: CustomerSyncBody,
  responseData: unknown,
  profile: CustomerProfile,
): CustomerIdentityMetafieldValues {
  const { loyaltyMembershipData } = extractResponseArrays(responseData);
  const responseRoots = getResponseRoots(responseData);
  const responseQCCode = responseRoots
    .map((record) => extractStringValue(record.QCCode))
    .find((value): value is string => Boolean(value));

  const personQCCode =
    responseQCCode ??
    extractStringValue(body.QCCode) ??
    findFirstNestedValue(responseData, [
      "QCCode",
      "personQCCode",
      "personCode",
      "personId",
      "personID",
    ]);

  const loyaltyQCCode =
    extractFirstArrayQCCode(loyaltyMembershipData) ??
    extractFirstArrayQCCode(body.loyaltyMembershipData) ??
    findFirstNestedValue(responseData, [
      "membershipQCCode",
      "membershipCode",
      "loyaltyQCCode",
      "loyaltyCode",
      "membershipNumber",
      "loyaltyNumber",
      "qcCode",
      "code",
    ]);

  const countryCode =
    normalizeCountryCode(body.countryCode) ??
    findFirstNestedValue(body.telephoneList, ["countryCode", "country"]) ??
    findFirstNestedValue(responseData, ["countryCode", "country"]);
  const phone = normalizePhoneForMetafield(profile.phone, countryCode);
  const tier =
    extractTierFromLoyaltyMembershipData(loyaltyMembershipData) ??
    extractTierFromLoyaltyMembershipData(body.loyaltyMembershipData) ??
    findFirstNestedValue(responseData, ["category", "tier"]);
  const canRedeem =
    extractCanRedeemFromLoyaltyMembershipData(loyaltyMembershipData) ??
    extractCanRedeemFromLoyaltyMembershipData(body.loyaltyMembershipData) ??
    normalizeBooleanValue(findFirstNestedValue(responseData, ["CANREDEEM"])) ??
    normalizeBooleanValue(findFirstNestedValue(responseData, ["canRedeem"]));
  const redeemPoint =
    extractRedeemPointFromLoyaltyMembershipData(loyaltyMembershipData) ??
    extractRedeemPointFromLoyaltyMembershipData(body.loyaltyMembershipData) ??
    findFirstNestedValue(responseData, [
      "pointBalance",
      "redeemPoint",
      "redeem_point",
    ]);

  const loyaltySync =
    normalizeBooleanValue(body.loyaltySync) ??
    normalizeBooleanValue(
      findFirstNestedValue(responseData, ["loyaltySync"]),
    ) ??
    false;

  return {
    personQCCode,
    loyaltyQCCode,
    countryCode,
    phone,
    tier,
    redeemPoint,
    canRedeem,
    loyaltySync,
  };
}

async function createShopifyCustomer(
  adminClient: AdminGraphqlClient,
  profile: CustomerProfile,
): Promise<ShopifyCustomerNode> {
  const addresses = extractCustomerAddresses(profile);

  const createCustomerResponse = await adminClient.graphql(
    `#graphql
      mutation CreateCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          email: profile.email,
          ...(addresses ? { addresses } : {}),
        },
      },
    },
  );

  const createCustomerResult = (await createCustomerResponse.json()) as {
    data?: {
      customerCreate?: {
        customer?: {
          id: string;
        } | null;
        userErrors?: Array<{ message?: string }>;
      };
    };
  };

  const createErrors =
    createCustomerResult.data?.customerCreate?.userErrors ?? [];
  if (createErrors.length > 0) {
    throw new Error(
      createErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", "),
    );
  }

  const createdCustomer = createCustomerResult.data?.customerCreate?.customer;
  if (!createdCustomer) {
    throw new Error("customer could not be created in Shopify");
  }
  console.log(
    `[createShopifyCustomer] Created customer with ID ${createdCustomer.id}`,
  );
  return {
    id: createdCustomer.id,
  };
}

async function updateShopifyCustomer(
  adminClient: AdminGraphqlClient,
  customerId: string,
  profile: CustomerProfile,
): Promise<void> {
  const input: Record<string, unknown> = {
    id: customerId,
  };

  if (profile.email) {
    input.email = profile.email;
  }

  // NOTE: phone is intentionally omitted here.
  // Phone is saved exclusively as a metafield (custom.phone)
  // via setCustomerIdentityMetafields, not on the customer profile.

  const addresses = extractCustomerAddresses(profile);
  if (addresses) {
    input.addresses = addresses;
  }

  const updateCustomerResponse = await adminClient.graphql(
    `#graphql
      mutation UpdateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: { input },
    },
  );

  const updateCustomerResult = (await updateCustomerResponse.json()) as {
    data?: {
      customerUpdate?: {
        customer?: {
          id: string;
        } | null;
        userErrors?: Array<{ message?: string }>;
      };
    };
  };

  const updateErrors =
    updateCustomerResult.data?.customerUpdate?.userErrors ?? [];
  if (updateErrors.length > 0) {
    throw new Error(
      updateErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", "),
    );
  }
}

async function findCustomerIdByIdentityMetafield(
  adminClient: AdminGraphqlClient,
  namespace: string,
  key: "person_qc_code" | "loyalty_qc_code" | "phone",
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }

  const query = `metafields.${namespace}.${key}:${JSON.stringify(value)}`;

  const response = await adminClient.graphql(
    `#graphql
      query FindCustomerByMetafield($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `,
    {
      variables: { query },
    },
  );

  const result = (await response.json()) as {
    data?: CustomersByMetafieldData;
    errors?: Array<{ message?: string }>;
  };

  const graphqlErrors = result.errors ?? [];
  if (graphqlErrors.length > 0) {
    throw new Error(
      graphqlErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", "),
    );
  }

  return result.data?.customers?.edges?.[0]?.node?.id;
}

async function findCustomerIdByEmail(
  adminClient: AdminGraphqlClient,
  email: string,
): Promise<string | undefined> {
  if (!email) {
    return undefined;
  }

  console.log(`[Shopify] Looking up customer by email: ${email}`);

  const response = await adminClient.graphql(
    `#graphql
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `,
    {
      variables: { query: `email:${JSON.stringify(email)}` },
    },
  );

  const result = (await response.json()) as {
    data?: CustomersByMetafieldData;
    errors?: Array<{ message?: string }>;
  };

  const graphqlErrors = result.errors ?? [];
  if (graphqlErrors.length > 0) {
    throw new Error(
      graphqlErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", "),
    );
  }

  const customerId = result.data?.customers?.edges?.[0]?.node?.id;
  if (customerId) {
    console.log(
      `[Shopify] Found existing customer ${customerId} by email: ${email}`,
    );
  } else {
    console.log(`[Shopify] No existing customer found for email: ${email}`);
  }

  return customerId;
}

async function setCustomerIdentityMetafields(
  adminClient: AdminGraphqlClient,
  customerId: string,
  namespace: string,
  values: CustomerIdentityMetafieldValues,
): Promise<SaveCustomerMetafieldsResult> {
  const ownerId = toShopifyCustomerGid(customerId);
  if (!ownerId) {
    throw new Error(
      "Invalid Shopify customer ID provided for metafield ownerId",
    );
  }

  const metafieldsToSet = [
    { key: "person_qc_code", value: values.personQCCode }, // ✅ no spaces
    { key: "loyalty_qc_code", value: values.loyaltyQCCode }, // ✅ no spaces
    { key: "country_code", value: values.countryCode },
    { key: "phone", value: values.phone },
    { key: "tier", value: values.tier },
    { key: "redeem_point", value: values.redeemPoint },
    { key: "qivos_note", value: values.qivosNote },
    {
      key: "can_redeem",
      type: "boolean",
      value:
        values.canRedeem === undefined
          ? undefined
          : values.canRedeem
            ? "true"
            : "false",
    },
    {
      key: "loyalty_sync",
      type: "boolean",
      value:
        values.loyaltySync === undefined
          ? undefined
          : values.loyaltySync
            ? "true"
            : "false",
    },
  ]
    .filter((item) => item.value !== undefined)
    .map((item) => ({
      ownerId,
      namespace,
      key: item.key,
      type: item.type ?? "single_line_text_field",
      value: item.value as string,
    }));

  if (metafieldsToSet.length === 0) {
    return {
      addedKeys: [],
      skippedReason: "no metafield values were available",
      shopAuthenticated: !adminClient.usedStoredAccessToken,
      savedValues: values,
    };
  }

  const metafieldsResponse = await adminClient.graphql(
    `#graphql
      mutation SetCustomerMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { metafields: metafieldsToSet } },
  );

  if (metafieldsResponse.status === 401) {
    throw new Error(
      `Shopify Admin API authentication failed (401) for this shop. ` +
        `Please reinstall the app to refresh the access token.`,
    );
  }

  const metafieldsResult = (await metafieldsResponse.json()) as {
    errors?: string | Record<string, unknown>;
    data?: {
      metafieldsSet?: {
        metafields?: Array<{ key?: string }>;
        userErrors?: Array<{ field?: string[]; message?: string }>;
      };
    };
  };

  // ✅ Top-level API errors check
  if (metafieldsResult.errors) {
    throw new Error(
      `Shopify API error: ${JSON.stringify(metafieldsResult.errors)}`,
    );
  }

  const userErrors = metafieldsResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      userErrors.map((e) => `${e.field?.join(".")}: ${e.message}`).join(", "),
    );
  }

  return {
    addedKeys:
      metafieldsResult.data?.metafieldsSet?.metafields
        ?.map((m) => m.key)
        .filter((key): key is string => Boolean(key)) ?? [],
    shopAuthenticated: !adminClient.usedStoredAccessToken,
    savedValues: values,
  };
}

export async function saveCustomerIdentityMetafields({
  shop,
  customerId,
  namespace = DEFAULT_METAFIELD_NAMESPACE,
  values,
}: {
  shop: string;
  customerId: string;
  namespace?: string;
  values: CustomerIdentityMetafieldValues;
}): Promise<SaveCustomerMetafieldsResult> {
  const adminClient = await getAdminGraphqlClient(shop);
  return setCustomerIdentityMetafields(
    adminClient,
    customerId,
    namespace,
    values,
  );
}

export async function syncCustomerMetafields(
  request: Request,
  body: CustomerSyncBody,
  responseData: unknown,
): Promise<CustomerMetafieldSyncResult> {
  const shop = await resolveCurrentShop(request, body);
  if (!shop) {
    return {
      synced: false,
      skippedReason:
        "shop could not be resolved; pass shop in body/query/header or ensure an offline Shopify session exists",
    };
  }

  const namespace = body.metafieldNamespace || DEFAULT_METAFIELD_NAMESPACE;
  const profile = buildCustomerProfile(body, responseData);
  const values = extractMetafieldValues(body, responseData, profile);
  const providedCustomerId = extractStringValue(body.customerId);

  const hasIdentityMetafield = Boolean(
    values.personQCCode || values.loyaltyQCCode,
  );

  if (!providedCustomerId && !profile.email && !hasIdentityMetafield) {
    return {
      synced: false,
      shop,
      skippedReason:
        "customerId, customer email, or an identity metafield is required to sync Shopify customer",
    };
  }

  let adminClient;
  try {
    adminClient = await getAdminGraphqlClient(shop);
  } catch (error) {
    if (error instanceof Error) {
      return {
        synced: false,
        shop,
        skippedReason: error.message,
        shopAuthenticated: false,
      };
    }
    throw error;
  }

  if (adminClient.usedStoredAccessToken) {
    console.warn(
      `[syncCustomerMetafields] Using stored token for ${shop} — may be expired`,
    );
  }
  let customerId = providedCustomerId;
  let customerCreated = false;

  await ensureMetafieldDefinitions(adminClient, namespace);

  if (!customerId) {
    try {
      const customer = await createShopifyCustomer(adminClient, profile);
      customerId = customer.id;
      customerCreated = true;
    } catch (error: any) {
      const isAlreadyTaken =
        error.message?.includes("taken") ||
        error.message?.includes("already exists");

      if (isAlreadyTaken) {
        customerId =
          (await findCustomerIdByIdentityMetafield(
            adminClient,
            namespace,
            "person_qc_code",
            values.personQCCode,
          )) ??
          (await findCustomerIdByIdentityMetafield(
            adminClient,
            namespace,
            "loyalty_qc_code",
            values.loyaltyQCCode,
          )) ??
          (await findCustomerIdByIdentityMetafield(
            adminClient,
            namespace,
            "phone",
            values.phone,
          )) ??
          (profile.email
            ? await findCustomerIdByEmail(adminClient, profile.email)
            : undefined);

        if (!customerId) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  const metafieldSaveResult = await setCustomerIdentityMetafields(
    adminClient,
    customerId,
    namespace,
    values,
  );

  if (metafieldSaveResult.skippedReason) {
    return {
      synced: true,
      shop,
      customerId,
      email: profile.email,
      customerCreated,
      addedKeys: metafieldSaveResult.addedKeys,
      skippedReason: metafieldSaveResult.skippedReason,
      shopAuthenticated: metafieldSaveResult.shopAuthenticated,
      savedValues: metafieldSaveResult.savedValues,
    };
  }

  return {
    synced: true,
    shop,
    customerId,
    email: profile.email,
    customerCreated,
    shopAuthenticated: metafieldSaveResult.shopAuthenticated,
    addedKeys: metafieldSaveResult.addedKeys,
    savedValues: metafieldSaveResult.savedValues,
  };
}

export async function getCustomerIdentityMetafields({
  shop,
  customerId,
  namespace = DEFAULT_METAFIELD_NAMESPACE,
}: {
  shop: string;
  customerId: string;
  namespace?: string;
}): Promise<CustomerIdentityMetafieldValues> {
  const adminClient = await getAdminGraphqlClient(shop);

  const response = await adminClient.graphql(
    `#graphql
      query GetCustomerMetafields($customerId: ID!, $namespace: String!) {
        customer(id: $customerId) {
          personQCCode: metafield(namespace: $namespace, key: "person_qc_code") {
            value
          }
          loyaltyQCCode: metafield(namespace: $namespace, key: "loyalty_qc_code") {
            value
          }
          countryCode: metafield(namespace: $namespace, key: "country_code") {
            value
          }
          phone: metafield(namespace: $namespace, key: "phone") {
            value
          }
          tier: metafield(namespace: $namespace, key: "tier") {
            value
          }
          redeemPoint: metafield(namespace: $namespace, key: "redeem_point") {
            value
          }
          canRedeem: metafield(namespace: $namespace, key: "can_redeem") {
            value
          }
          loyaltySync: metafield(namespace: $namespace, key: "loyalty_sync") {
            value
          }
        }
      }
    `,
    {
      variables: { customerId, namespace },
    },
  );

  const result = (await response.json()) as {
    data?: {
      customer?: {
        personQCCode?: { value?: string } | null;
        loyaltyQCCode?: { value?: string } | null;
        countryCode?: { value?: string } | null;
        phone?: { value?: string } | null;
        tier?: { value?: string } | null;
        redeemPoint?: { value?: string } | null;
        canRedeem?: { value?: string } | null;
        loyaltySync?: { value?: string } | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  const errors = result.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((e) => e.message)
        .filter(Boolean)
        .join(", "),
    );
  }

  const customer = result.data?.customer;

  return {
    personQCCode: customer?.personQCCode?.value ?? undefined,
    loyaltyQCCode: customer?.loyaltyQCCode?.value ?? undefined,
    countryCode: normalizeCountryCode(customer?.countryCode?.value),
    phone: customer?.phone?.value ?? undefined,
    tier: customer?.tier?.value ?? undefined,
    redeemPoint: customer?.redeemPoint?.value ?? undefined,
    canRedeem: customer?.canRedeem?.value === "true",
    loyaltySync: customer?.loyaltySync?.value === "true",
  };
}
