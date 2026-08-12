import { getAdminGraphqlClient } from "./shopify-admin.server";
import prisma from "../db.server";

const POINTS_TO_CREDIT_RATE = 0.1836;

export type CustomerCreditInput = {
  shop: string;
  customerId: string;
  redeemPoints: number;
  /**
   * Optional idempotency key (e.g. the order number). When provided, the same
   * key is credited at most once — a duplicate request returns the prior
   * result instead of adding the credit again.
   */
  redemptionKey?: string;
};

export type CustomerCreditResult = {
  success: boolean;
  shop: string;
  customerId: string;
  redeemPoints: number;
  creditAmount: number;
  data?: unknown;
  previousBalance?: number;
  finalBalance?: string;
  remainingRedeemPoints?: number;
  skipped?: boolean;
  skipReason?: string;
};

function toMoneyAmount(amount: number): string {
  return amount.toFixed(2);
}

export function getStoreCreditPermissionError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (/Access denied for storeCreditAccounts field/i.test(message)) {
    return "Missing Shopify scope: read_store_credit_accounts";
  }
  if (
    /Access denied for storeCreditAccount(Credit|Debit) field/i.test(message)
  ) {
    return "Missing Shopify scope: write_store_credit_account_transactions";
  }

  return null;
}

type StoreCreditTransactionData = {
  data?: {
    storeCreditAccountCredit?: {
      storeCreditAccountTransaction?: {
        id?: string;
        amount?: {
          amount?: string;
          currencyCode?: string;
        };
        account?: {
          id?: string;
          balance?: {
            amount?: string;
            currencyCode?: string;
          };
        };
      };
      userErrors?: Array<{
        field?: string[];
        message?: string;
      }>;
    };
    storeCreditAccountDebit?: {
      storeCreditAccountTransaction?: {
        id?: string;
        amount?: {
          amount?: string;
          currencyCode?: string;
        };
        account?: {
          id?: string;
          balance?: {
            amount?: string;
            currencyCode?: string;
          };
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

type StoreCreditTransaction = NonNullable<
  NonNullable<
    NonNullable<StoreCreditTransactionData["data"]>["storeCreditAccountCredit"]
  >["storeCreditAccountTransaction"]
>;

function assertNoGraphqlErrors(
  responseData: StoreCreditTransactionData,
  userErrors:
    | Array<{
        field?: string[];
        message?: string;
      }>
    | undefined,
) {
  if (responseData.errors?.length) {
    throw new Error(
      responseData.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", "),
    );
  }

  if (userErrors?.length) {
    throw new Error(
      userErrors
        .map((error) => `${error.field?.join(".")}: ${error.message}`)
        .join(", "),
    );
  }
}

export async function creditCustomerStoreCredit({
  shop,
  customerId,
  redeemPoints,
  redemptionKey,
}: CustomerCreditInput): Promise<CustomerCreditResult> {
  if (!Number.isFinite(redeemPoints) || redeemPoints < 0) {
    throw new Error(`Invalid redeem points value: ${redeemPoints}`);
  }

  if (redeemPoints === 0) {
    return {
      success: true,
      shop,
      customerId,
      redeemPoints: 0,
      creditAmount: 0,
      remainingRedeemPoints: 0,
    };
  }

  const adminClient = await getAdminGraphqlClient(shop);
  const creditAmount = Number(
    (redeemPoints * POINTS_TO_CREDIT_RATE).toFixed(2),
  );

  if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
    throw new Error(
      `Invalid credit amount derived from redeem points: ${redeemPoints}`,
    );
  }

  // Idempotency: claim the redemption key before touching Shopify. The unique
  // constraint on [shopDomain, redemptionKey] guarantees only one request wins;
  // any concurrent or repeated request short-circuits here.
  if (redemptionKey) {
    const existing = await prisma.creditRedemption.findUnique({
      where: {
        shopDomain_redemptionKey: { shopDomain: shop, redemptionKey },
      },
    });

    if (existing && existing.status !== "FAILED") {
      return {
        success: existing.status === "COMPLETED",
        skipped: true,
        skipReason:
          existing.status === "COMPLETED"
            ? "Redemption already processed"
            : "Redemption already in progress",
        shop,
        customerId,
        redeemPoints,
        creditAmount: existing.creditAmount,
        finalBalance: undefined,
        remainingRedeemPoints: 0,
      };
    }

    // Claim (or re-claim a previously failed) key.
    await prisma.creditRedemption.upsert({
      where: {
        shopDomain_redemptionKey: { shopDomain: shop, redemptionKey },
      },
      create: {
        shopDomain: shop,
        customerId,
        redemptionKey,
        redeemPoints,
        creditAmount,
        status: "PENDING",
      },
      update: {
        customerId,
        redeemPoints,
        creditAmount,
        status: "PENDING",
        error: null,
      },
    });
  }

  try {
    // Step 1: Get previous balance + account ID
    const balanceResponse = await adminClient.graphql(
      `#graphql
        query GetStoreCreditBalance($id: ID!) {
          customer(id: $id) {
            storeCreditAccounts(first: 1) {
              nodes {
                id
                balance {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      `,
      { variables: { id: customerId } },
    );

    const balanceData = (await balanceResponse.json()) as {
      data?: {
        customer?: {
          storeCreditAccounts?: {
            nodes?: Array<{
              id?: string;
              balance?: {
                amount?: string;
                currencyCode?: string;
              };
            }>;
          };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (balanceData.errors?.length) {
      throw new Error(
        balanceData.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join(", "),
      );
    }

    const shopResponse = await adminClient.graphql(`#graphql
      query ShopCurrency {
        shop {
          currencyCode
        }
      }
    `);

    const shopData = (await shopResponse.json()) as {
      data?: { shop?: { currencyCode?: string } };
    };

    const accountNode =
      balanceData.data?.customer?.storeCreditAccounts?.nodes?.[0];

    const storeCreditAccountId = accountNode?.id;
    const storeCreditCurrencyCode =
      accountNode?.balance?.currencyCode ?? shopData.data?.shop?.currencyCode;

    if (!storeCreditCurrencyCode) {
      throw new Error("Unable to determine store credit currency code");
    }

    // Balance before this redemption (for reporting only).
    const previousBalance = Number(
      parseFloat(accountNode?.balance?.amount ?? "0").toFixed(2),
    );

    // Step 2: Make the account balance match the current cart redemption.
    // Shopify exposes credit/debit transactions, so replacing the checkout
    // credit means applying only the difference from the current balance.
    const balanceDelta = Number((creditAmount - previousBalance).toFixed(2));
    const transactionId = storeCreditAccountId ?? customerId;

    let creditData: StoreCreditTransactionData | undefined;
    let transaction: StoreCreditTransaction | undefined;

    if (balanceDelta > 0) {
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
            id: transactionId,
            creditInput: {
              creditAmount: {
                amount: toMoneyAmount(balanceDelta),
                currencyCode: storeCreditCurrencyCode,
              },
            },
          },
        },
      );

      creditData = (await creditResponse.json()) as StoreCreditTransactionData;
      assertNoGraphqlErrors(
        creditData,
        creditData.data?.storeCreditAccountCredit?.userErrors,
      );
      transaction =
        creditData.data?.storeCreditAccountCredit
          ?.storeCreditAccountTransaction;
    } else if (balanceDelta < 0) {
      const debitResponse = await adminClient.graphql(
        `#graphql
          mutation StoreCreditAccountDebit(
            $id: ID!
            $debitInput: StoreCreditAccountDebitInput!
          ) {
            storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
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
            id: transactionId,
            debitInput: {
              debitAmount: {
                amount: toMoneyAmount(Math.abs(balanceDelta)),
                currencyCode: storeCreditCurrencyCode,
              },
            },
          },
        },
      );

      creditData = (await debitResponse.json()) as StoreCreditTransactionData;
      assertNoGraphqlErrors(
        creditData,
        creditData.data?.storeCreditAccountDebit?.userErrors,
      );
      transaction =
        creditData.data?.storeCreditAccountDebit?.storeCreditAccountTransaction;
    }

    const finalBalance =
      transaction?.account?.balance?.amount ?? toMoneyAmount(previousBalance);

    if (redemptionKey) {
      await prisma.creditRedemption.update({
        where: {
          shopDomain_redemptionKey: { shopDomain: shop, redemptionKey },
        },
        data: {
          status: "COMPLETED",
          currencyCode: transaction?.amount?.currencyCode,
          transactionId: transaction?.id,
        },
      });
    }

    return {
      success: true,
      shop,
      customerId,
      redeemPoints,
      creditAmount,
      previousBalance,
      finalBalance,
      remainingRedeemPoints: 0,
      data: creditData?.data,
    };
  } catch (error) {
    const permissionError = getStoreCreditPermissionError(error);
    const message =
      permissionError ??
      (error instanceof Error ? error.message : "Unknown error");

    // Release the claim so the redemption can be retried with the same key.
    if (redemptionKey) {
      await prisma.creditRedemption
        .update({
          where: {
            shopDomain_redemptionKey: { shopDomain: shop, redemptionKey },
          },
          data: { status: "FAILED", error: message },
        })
        .catch(() => {});
    }

    throw new Error(message);
  }
}
