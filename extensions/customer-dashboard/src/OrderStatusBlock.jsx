import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

const APP_URL = 'https://dd-79.dynamicdreamz.com';
const CUSTOMER_METAFIELDS_ENDPOINT =
  `${APP_URL}/customer-account/metafields`;
const BE_U_ACCOUNT_URL =
  'https://edpnam-40.myshopify.com/pages/loyalty-account?view=loyalty-account';

export default async function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const [state, setState] = useState({
    loading: true,
    linked: false,
    phone: '',
    pointBalance: '',
    personQCCode: '',
    loyaltyQCCode: '',
    loyaltySync: false,
    error: '',
    debug: '',
  });

  useEffect(() => {
    let active = true;

    async function loadCustomerMetafields() {
      try {
        const customerId =
          globalThis.shopify?.authenticatedAccount?.customer?.value?.id;

        if (!customerId) {
          if (!active) return;
          setState((prev) => ({
            ...prev,
            loading: false,
            linked: false,
          }));
          return;
        }

        const idToken = await globalThis.shopify.sessionToken.get();
        const url = new URL(CUSTOMER_METAFIELDS_ENDPOINT);
        url.searchParams.set('customerId', customerId);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
        });

        const result = await response.json();

        if (!active) return;

        if (!response.ok || result.ok === false) {
          throw new Error(
            result.error ||
              `Failed to load customer metafields (${response.status})`,
          );
        }
        const personQCCode = result.personQCCode ?? '';
        const loyaltyQCCode = result.loyaltyQCCode ?? '';
        const phone = result.phone ?? '';
        const pointBalance = result.pointBalance ?? '';
        const loyaltySync = result.loyaltySync === true;
        const linked = Boolean(
          loyaltySync || (personQCCode && loyaltyQCCode && phone),
        );

        setState({
          loading: false,
          linked,
          phone,
          pointBalance,
          personQCCode,
          loyaltyQCCode,
          loyaltySync,
          error: '',
          debug: JSON.stringify(
            {
              customerId,
              endpoint: url.toString(),
              response: result,
            },
            null,
            2,
          ),
        });
      } catch (error) {
        if (!active) return;

        setState((prev) => ({
          ...prev,
          loading: false,
          linked: false,
          error: error instanceof Error ? error.message : 'Unable to load account status.',
          debug:
            error instanceof Error
              ? error.stack ?? error.message
              : 'Unknown extension error',
        }));
      }
    }

    loadCustomerMetafields();

    return () => {
      active = false;
    };
  }, []);

  if (state.loading) {
    return (
      <s-box padding="base">
        <s-text>Loading Be U account status...</s-text>
      </s-box>
    );
  }

  return (
    <s-box padding="base">
      {state.linked ? (
        <s-banner tone="success" heading="Congratulations!">
          <s-text>
            We have created and linked your Be U account successfully. You can now enjoy personalized rewards and offers.
          </s-text>
        </s-banner>
      ) : (
        <s-banner tone="info" heading="Be U account not linked">
          <s-text>
            Create or link your Be U account to manage rewards and profile sync.
          </s-text>
        </s-banner>
      )}

      {state.error ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning" heading="Status unavailable">
            <s-text>{state.error}</s-text>
          </s-banner>
        </s-box>
      ) : null}

      <s-box paddingBlockStart="base">
        <s-grid
          gridTemplateColumns="1fr 280px"
          gap="base"
          border="base"
          borderRadius="base"
          padding="base"
        >
          <s-box>
          {state.linked ? (
            <>
              <s-heading>Be U account linked</s-heading>
              <s-box paddingBlockStart="small" />
              <s-text>
                Your customer profile is connected successfully.
              </s-text>
              <s-box paddingBlockStart="base" />
              <s-grid gridTemplateColumns="1fr 1fr" gap="small">
                <s-text type="strong">Reward Points Balance:</s-text>
                <s-text type="strong">
                  {state.pointBalance ? `${state.pointBalance} Points` : '0 Points'}
                </s-text>
              </s-grid>
              <s-box paddingBlockStart="small" />
            </>
          ) : (
            <>
              <s-heading>Create/Link your Be U account here</s-heading>
              <s-box paddingBlockStart="small" />
              <s-text>
                Connect your Be U account to sync your profile and loyalty details.
              </s-text>
              <s-box paddingBlockStart="base" />
              <s-link href={BE_U_ACCOUNT_URL}>Create or link your Be U account</s-link>
            </>
          )}
          </s-box>
        </s-grid>
      </s-box>
    </s-box>
  );
}
