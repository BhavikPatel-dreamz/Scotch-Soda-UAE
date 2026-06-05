import { getAdminGraphqlClient } from "./shopify-admin.server";

const SHOPIFY_CURRENCY_CODE = "INR";
const POINTS_TO_CREDIT_RATE = 0.1;

export type CustomerCreditInput = {
  shop: string;
  customerId: string;
  redeemPoints: number;
};

export type CustomerCreditResult = {
  success: boolean;
  shop: string;
  customerId: string;
  redeemPoints: number;
  creditAmount: number;
  data?: unknown;
};

export function getStoreCreditPermissionError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (/Access denied for storeCreditAccounts field/i.test(message)) {
    return "Missing Shopify scope: read_store_credit_accounts";
  }
  if (/Access denied for storeCreditAccountCredit field/i.test(message)) {
    return "Missing Shopify scope: write_store_credit_account_transactions";
  }

  return null;
}

export async function creditCustomerStoreCredit({
  shop,
  customerId,
  redeemPoints,
}: CustomerCreditInput): Promise<CustomerCreditResult> {
  const adminClient = await getAdminGraphqlClient(shop);
  const creditAmount = redeemPoints * POINTS_TO_CREDIT_RATE;

  try {
    const creditResponse = await adminClient.graphql(
      `#graphql
        mutation StoreCreditAccountCredit(
          $id: ID!
          $creditInput: StoreCreditAccountCreditInput!
        ) {
          storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
            storeCreditAccountTransaction {
              id
              amount {
                amount
                currencyCode
              }
              account {
                id
                balance {
                  amount
                  currencyCode
                }
              }
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
          id: customerId,
          creditInput: {
            creditAmount: {
              amount: creditAmount,
              currencyCode: SHOPIFY_CURRENCY_CODE,
            },
          },
        },
      },
    );

    const creditData = (await creditResponse.json()) as {
      data?: {
        storeCreditAccountCredit?: {
          storeCreditAccountTransaction?: {
            id?: string;
            amount?: {
              amount?: string;
              currencyCode?: string;
            };
          };
          userErrors?: Array<{
            field?: string[];
            message?: string;
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (creditData.errors?.length) {
      throw new Error(
        creditData.errors.map((error) => error.message).filter(Boolean).join(", "),
      );
    }

    const userErrors =
      creditData.data?.storeCreditAccountCredit?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        userErrors.map((error) => `${error.field?.join(".")}: ${error.message}`).join(", "),
      );
    }

    return {
      success: true,
      shop,
      customerId,
      redeemPoints,
      creditAmount,
      data: creditData.data,
    };
  } catch (error) {
    const permissionError = getStoreCreditPermissionError(error);
    throw new Error(
      permissionError ??
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}
