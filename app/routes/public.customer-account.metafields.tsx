import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getCustomerIdentityMetafields } from "../utils/shopify-customer-metafields.server";
import { normalizeShopDomain, toShopifyCustomerGid } from "../utils/store.server";
import { getQIVOSToken } from "../utils/qivos-token.server";
import { QIVOS_BESIDE_API_BASE_URL } from "../utils/constants";

const QIVOS_PERSONS_SEARCH_URL =
  `${QIVOS_BESIDE_API_BASE_URL}/qc-api/v1.0/persons/search`;

type QivosSearchCriteria =
  | {
      criteriaType: "TELEPHONE";
      countryCode: string;
      telephoneNumber: string;
      telephoneType: string;
      isPrimary: boolean;
    }
  | {
      criteriaType: "EMAIL";
      emailAddress: string;
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

function normalizePhoneForQivos(phone: string | undefined): string | undefined {
  if (!phone) return undefined;

  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

function extractPointBalanceFromPerson(person: unknown): string | undefined {
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

async function getCustomerPointBalance(params: {
  phone?: string;
  email?: string;
}): Promise<string | undefined> {
  const phone = normalizePhoneForQivos(params.phone);
  const email = params.email?.trim();

  if (!phone && !email) {
    return undefined;
  }

  const token = await getQIVOSToken();
  const payload: QivosSearchPayload = phone
    ? {
        criteriaList: [
          {
            criteriaType: "TELEPHONE",
            countryCode: "in",
            telephoneNumber: phone,
            telephoneType: "MOBILE",
            isPrimary: true,
          },
        ],
        pagination: { page: 1, pageSize: 10 },
        sorting: { sortingField: "ID", sortingOrder: "DESC" },
      }
    : {
        criteriaList: [
          {
            criteriaType: "EMAIL",
            emailAddress: email as string,
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

  if (!response.ok) {
    throw new Error(`Failed to fetch Qivos point balance (${response.status})`);
  }

  const responseData = (await response.json()) as {
    payload?: {
      data?: unknown[];
    };
  };

  const persons = Array.isArray(responseData.payload?.data)
    ? responseData.payload.data
    : [];

  for (const person of persons) {
    const pointBalance = extractPointBalanceFromPerson(person);
    if (pointBalance) {
      return pointBalance;
    }
  }

  return undefined;
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
  const { cors, sessionToken } = await authenticate.public.customerAccount(
    request,
  );

  const url = new URL(request.url);
  const requestedCustomerId = url.searchParams.get("customerId");
  const tokenCustomerId =
    typeof sessionToken.sub === "string"
      ? toShopifyCustomerGid(sessionToken.sub)
      : undefined;
  const customerId = tokenCustomerId ?? toShopifyCustomerGid(requestedCustomerId);
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
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );
  }

  try {
    const metafields = await getCustomerIdentityMetafields({
      shop,
      customerId,
    });
    const pointBalance = await getCustomerPointBalance({
      phone: metafields.phone,
      email: metafields.email,
    });

    return cors(
      new Response(
        JSON.stringify({
          ok: true,
          shop,
          customerId,
          ...metafields,
          pointBalance,
          debug: {
            tokenSub: sessionToken.sub ?? null,
            tokenDest: sessionToken.dest ?? null,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
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
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );
  }
};
