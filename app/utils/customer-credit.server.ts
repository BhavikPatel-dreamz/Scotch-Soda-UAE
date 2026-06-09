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
  previousBalance?: number;
  finalBalance?: string;
  
};

function toMoneyAmount(amount: number): string {
  return amount.toFixed(2);
}

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

// export async function creditCustomerStoreCredit({
//   shop,
//   customerId,
//   redeemPoints,
// }: CustomerCreditInput): Promise<CustomerCreditResult> {
//   const adminClient = await getAdminGraphqlClient(shop);
//   const creditAmount = redeemPoints * POINTS_TO_CREDIT_RATE;

//   try {
//     const creditResponse = await adminClient.graphql(
//       `#graphql
//         mutation StoreCreditAccountCredit(
//           $id: ID!
//           $creditInput: StoreCreditAccountCreditInput!
//         ) {
//           storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
//             storeCreditAccountTransaction {
//               id
//               amount {
//                 amount
//                 currencyCode
//               }
//               account {
//                 id
//                 balance {
//                   amount
//                   currencyCode
//                 }
//               }
//             }
//             userErrors {
//               field
//               message
//             }
//           }
//         }
//       `,
//       {
//         variables: {
//           id: customerId,
//           creditInput: {
//             creditAmount: {
//               amount: creditAmount,
//               currencyCode: SHOPIFY_CURRENCY_CODE,
//             },
//           },
//         },
//       },
//     );

//     const creditData = (await creditResponse.json()) as {
//       data?: {
//         storeCreditAccountCredit?: {
//           storeCreditAccountTransaction?: {
//             id?: string;
//             amount?: {
//               amount?: string;
//               currencyCode?: string;
//             };
//           };
//           userErrors?: Array<{
//             field?: string[];
//             message?: string;
//           }>;
//         };
//       };
//       errors?: Array<{ message?: string }>;
//     };

//     if (creditData.errors?.length) {
//       throw new Error(
//         creditData.errors.map((error) => error.message).filter(Boolean).join(", "),
//       );
//     }

//     const userErrors =
//       creditData.data?.storeCreditAccountCredit?.userErrors ?? [];
//     if (userErrors.length > 0) {
//       throw new Error(
//         userErrors.map((error) => `${error.field?.join(".")}: ${error.message}`).join(", "),
//       );
//     }

//     return {
//       success: true,
//       shop,
//       customerId,
//       redeemPoints,
//       creditAmount,
//       data: creditData.data,
//     };
//   } catch (error) {
//     const permissionError = getStoreCreditPermissionError(error);
//     throw new Error(
//       permissionError ??
//         (error instanceof Error ? error.message : "Unknown error"),
//     );
//   }
// }

export async function creditCustomerStoreCredit({
  shop,
  customerId,
  redeemPoints,
}: CustomerCreditInput): Promise<CustomerCreditResult> {
  const adminClient = await getAdminGraphqlClient(shop);
  const creditAmount = Number((redeemPoints * POINTS_TO_CREDIT_RATE).toFixed(2));

  if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
    throw new Error(`Invalid credit amount derived from redeem points: ${redeemPoints}`);
  }

  try {
    // Step 1: Get previous balance
    const balanceResponse = await adminClient.graphql(
      `#graphql
        query GetStoreCreditBalance($id: ID!) {
          customer(id: $id) {
            storeCreditAccounts(first: 1) {
              nodes {
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
        balanceData.errors.map((error) => error.message).filter(Boolean).join(", "),
      );
    }

    const previousBalance = parseFloat(
      balanceData.data?.customer?.storeCreditAccounts?.nodes?.[0]?.balance?.amount ??
        "0",
    );

    // Step 2: Remove old balance if it exists
    if (previousBalance > 0) {
      const removeResponse = await adminClient.graphql(
        `#graphql
          mutation RemoveOldCredit(
            $id: ID!
            $debitInput: StoreCreditAccountDebitInput!
          ) {
            storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
              storeCreditAccountTransaction {
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
            id: customerId,
            debitInput: {
              debitAmount: {
                amount: toMoneyAmount(previousBalance),
                currencyCode: SHOPIFY_CURRENCY_CODE,
              },
            },
          },
        },
      );

      const removeData = (await removeResponse.json()) as {
        data?: {
          storeCreditAccountDebit?: {
            userErrors?: Array<{
              field?: string[];
              message?: string;
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      if (removeData.errors?.length) {
        throw new Error(
          removeData.errors.map((error) => error.message).filter(Boolean).join(", "),
        );
      }

      const removeErrors = removeData.data?.storeCreditAccountDebit?.userErrors ?? [];
      if (removeErrors.length > 0) {
        throw new Error(
          removeErrors.map((error) => `${error.field?.join(".")}: ${error.message}`).join(", "),
        );
      }
    }

    // Step 3: Add new credit amount
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
              amount: toMoneyAmount(creditAmount),
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

    const finalBalance =
      creditData.data?.storeCreditAccountCredit?.storeCreditAccountTransaction
        ?.account?.balance?.amount;

    return {
      success: true,
      shop,
      customerId,
      redeemPoints,
      creditAmount,
      previousBalance,
      finalBalance,
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
