import { QIVOS_BESIDE_API_BASE_URL } from "./constants";
import { getQIVOSToken, refreshQIVOSToken } from "./qivos-token.server";
import { extractStringValue, findFirstNestedValue } from "./qivos-utils.server";
import { getAdminGraphqlClient } from "./shopify-admin.server";

const QIVOS_PERSON_DETAILS_BASE_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons`;

export type ShopifyCustomerProfile = {
  firstName?: string;
  lastName?: string;
  email?: string;
};

export type QivosPersonRecord = Record<string, unknown>;

function extractPersonQCCode(person: QivosPersonRecord): string | undefined {
  return (
    extractStringValue(person.QCCode) ??
    extractStringValue(person.qcCode) ??
    extractStringValue(person.personQCCode)
  );
}

function extractPersonFirstName(person: QivosPersonRecord): string | undefined {
  return (
    extractStringValue(person.firstName) ??
    extractStringValue(person.givenName) ??
    findFirstNestedValue(person, ["firstName", "givenName"])
  );
}

function extractPersonLastName(person: QivosPersonRecord): string | undefined {
  return (
    extractStringValue(person.lastName) ??
    extractStringValue(person.familyName) ??
    extractStringValue(person.surname) ??
    findFirstNestedValue(person, ["lastName", "familyName", "surname"])
  );
}

function extractPersonEmail(person: QivosPersonRecord): string | undefined {
  return (
    extractStringValue(person.emailAddress) ??
    extractStringValue(person.email) ??
    findFirstNestedValue(person.emailList, ["emailAddress", "email"]) ??
    findFirstNestedValue(person, ["emailAddress", "email"])
  );
}

export function qivosPersonNeedsShopifyProfileBackfill(params: {
  person: QivosPersonRecord;
  profile?: ShopifyCustomerProfile | null;
}): boolean {
  const profile = params.profile;
  if (!profile) return false;

  return Boolean(
    (profile.firstName && !extractPersonFirstName(params.person)) ||
      (profile.lastName && !extractPersonLastName(params.person)) ||
      (profile.email && !extractPersonEmail(params.person)),
  );
}

function buildNamePatchPayload(params: {
  firstName?: string;
  lastName?: string;
}): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {};

  if (params.firstName) {
    payload.firstName = { value: params.firstName };
  }

  if (params.lastName) {
    payload.lastName = { value: params.lastName };
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

function buildEmailPatchPayload(emailAddress: string): Record<string, unknown> {
  return {
    emailAddress,
    isPrimary: true,
  };
}

async function sendQivosRequestWithRetry(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  async function execute(requestToken: string) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("x-jwt-token", requestToken);

    if (init.body !== undefined && init.body !== null && init.body !== "") {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url, {
      ...init,
      headers,
    });
  }

  let response = await execute(token);

  if (response.status === 401) {
    const refreshedToken = await refreshQIVOSToken();
    response = await execute(refreshedToken);
  }

  return response;
}

export async function fetchShopifyCustomerProfile(params: {
  shop: string;
  customerId: string;
}): Promise<ShopifyCustomerProfile | null> {
  const adminClient = await getAdminGraphqlClient(params.shop);

  const response = await adminClient.graphql(
    `#graphql
      query QivosBackfillCustomerProfile($customerId: ID!) {
        customer(id: $customerId) {
          firstName
          lastName
          email
        }
      }
    `,
    { variables: { customerId: params.customerId } },
  );

  const result = await response.json() as {
    data?: {
      customer?: {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  const errors = result.errors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).filter(Boolean).join(", "));
  }

  const customer = result.data?.customer;
  if (!customer) return null;

  return {
    firstName: customer.firstName ?? undefined,
    lastName: customer.lastName ?? undefined,
    email: customer.email ?? undefined,
  };
}

export async function backfillMissingQivosPersonDetails(params: {
  shop: string;
  customerId: string;
  person: QivosPersonRecord;
  profile?: ShopifyCustomerProfile | null;
  token?: string;
}): Promise<{
  personQCCode?: string;
  namePatched: boolean;
  emailPatched: boolean;
}> {
  const personQCCode = extractPersonQCCode(params.person);
  if (!personQCCode) {
    return {
      namePatched: false,
      emailPatched: false,
    };
  }

  const qivosFirstName = extractPersonFirstName(params.person);
  const qivosLastName = extractPersonLastName(params.person);
  const qivosEmail = extractPersonEmail(params.person);

  let profile = params.profile ?? null;
  if (!profile) {
    try {
      profile = await fetchShopifyCustomerProfile({
        shop: params.shop,
        customerId: params.customerId,
      });
    } catch (error) {
      console.warn("[QIVOS] Failed to load Shopify customer profile for backfill:", {
        personQCCode,
        error,
      });
      profile = null;
    }
  }

  if (!profile) {
    return {
      personQCCode,
      namePatched: false,
      emailPatched: false,
    };
  }

  const token = params.token ?? (await getQIVOSToken());

  let namePatched = false;
  let emailPatched = false;

  const namePayload = buildNamePatchPayload({
    firstName: !qivosFirstName ? profile.firstName : undefined,
    lastName: !qivosLastName ? profile.lastName : undefined,
  });

  if (namePayload) {
    try {
      const nameResponse = await sendQivosRequestWithRetry(
        `${QIVOS_PERSON_DETAILS_BASE_URL}/${encodeURIComponent(personQCCode)}`,
        {
          method: "PUT",
          body: JSON.stringify(namePayload),
        },
        token,
      );

      if (nameResponse.ok) {
        namePatched = true;
      } else {
        console.warn("[QIVOS] Failed to backfill missing person name:", {
          personQCCode,
          status: nameResponse.status,
        });
      }
    } catch (error) {
      console.warn("[QIVOS] Error while backfilling missing person name:", {
        personQCCode,
        error,
      });
    }
  }

  const missingEmail = !qivosEmail && profile.email;
  if (missingEmail) {
    try {
      const emailResponse = await sendQivosRequestWithRetry(
        `${QIVOS_PERSON_DETAILS_BASE_URL}/${encodeURIComponent(personQCCode)}/email`,
        {
          method: "PUT",
          body: JSON.stringify(buildEmailPatchPayload(profile.email as string)),
        },
        token,
      );

      if (emailResponse.ok) {
        emailPatched = true;
      } else {
        console.warn("[QIVOS] Failed to backfill missing person email:", {
          personQCCode,
          status: emailResponse.status,
        });
      }
    } catch (error) {
      console.warn("[QIVOS] Error while backfilling missing person email:", {
        personQCCode,
        error,
      });
    }
  }

  return {
    personQCCode,
    namePatched,
    emailPatched,
  };
}
