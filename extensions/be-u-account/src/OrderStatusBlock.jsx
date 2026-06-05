/**
 * @typedef {Object} InactiveMembership
 * @property {string} personQCCode
 * @property {string} loyaltyQCCode
 */

/**
 * @typedef {Object} CountryOption
 * @property {string} code
 * @property {string} apiCode
 * @property {string} dialCode
 * @property {string} name
 * @property {string} registrationStoreCode
 * @property {string} registrationCountryCode
 * @property {string} phonePlaceholder
 * @property {number} maxDigits
 * @property {(digits: string) => boolean} validate
 * @property {string} errorMessage
 */

/**
 * @typedef {Object} ExtensionState
 * @property {boolean} loading
 * @property {'phone' | 'otp' | 'activation' | 'success'} screen
 * @property {boolean} linked
 * @property {string} shop
 * @property {string} customerId
 * @property {string} email
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} countryCode
 * @property {string} phone
 * @property {string} otp
 * @property {string} pointBalance
 * @property {string} redeemPoint
 * @property {boolean} canRedeem
 * @property {string} personQCCode
 * @property {string} loyaltyQCCode
 * @property {string} tier
 * @property {boolean} loyaltySync
 * @property {boolean} sendingOtp
 * @property {boolean} verifyingOtp
 * @property {boolean} creatingPerson
 * @property {boolean} activatingAccount
 * @property {boolean} savingMetafields
 * @property {string} infoMessage
 * @property {string} errorMessage
 * @property {string} phoneError
 * @property {boolean} hasSavedPhone
 * @property {number} resendSecondsLeft
 * @property {boolean} otpFlowCompleted
 * @property {boolean} needsActivation
 * @property {boolean} isExistingPerson
 * @property {boolean} needsPatch
 * @property {InactiveMembership[]} inactiveMemberships
 * @property {CountryOption[]} countryOptions
 * @property {boolean} convertingToCredit
 */

/**
 * @typedef {Object} CustomerAccount
 * @property {string=} id
 * @property {string=} firstName
 * @property {string=} lastName
 * @property {string=} email
 */

/**
 * @typedef {Object} CustomerMetafieldsResponse
 * @property {boolean=} ok
 * @property {string=} error
 * @property {string=} phone
 * @property {string=} countryCode
 * @property {boolean=} loyaltySync
 * @property {string=} firstName
 * @property {string=} lastName
 * @property {string=} personQCCode
 * @property {string=} loyaltyQCCode
 * @property {string=} shop
 * @property {string=} email
 * @property {string=} redeemPoint
 * @property {string=} pointBalance
 * @property {boolean=} canRedeem
 * @property {string=} tier
 * @property {string=} shopCountryCode
 * @property {CountryOption[]=} availableCountries
 * @property {InactiveMembership[]=} inactiveMemberships
 * @property {boolean=} qivosBackfillApplied
 * @property {boolean=} qivosBackfillRequired
 * @property {boolean=} linked
 */

/**
 * @typedef {Object} PostJsonResponse
 * @property {boolean=} success
 * @property {string=} error
 * @property {string=} message
 * @property {string=} raw
 * @property {unknown=} [key]
 */

/**
 * @typedef {Object} OtpSession
 * @property {number} expires
 */

/**
 * @typedef {Object} MetafieldRow
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef {Object} FetchMetafieldsResult
 * @property {boolean} linked
 * @property {boolean} loyaltySync
 * @property {string=} shop
 * @property {string=} phone
 * @property {string=} customerId
 * @property {boolean=} qivosBackfillApplied
 * @property {boolean=} qivosBackfillRequired
 * @property {InactiveMembership[]=} inactiveMemberships
 *
 */

/* global globalThis */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const APP_URL = "https://dd-79.dynamicdreamz.com";
const CUSTOMER_METAFIELDS_ENDPOINT = `${APP_URL}/customer-account/metafields`;
const CUSTOMER_SEARCH_ENDPOINT = `${APP_URL}/api/proxy/persons/search`;
const SEND_OTP_ENDPOINT = `${APP_URL}/api/proxy/sendOTP`;
const VALIDATE_OTP_ENDPOINT = `${APP_URL}/api/proxy/validateOTP`;
const PERSONS_ENDPOINT = `${APP_URL}/api/proxy/persons`;
const CUSTOMER_CREDIT_ENDPOINT = `${APP_URL}/api/proxy/customerCredit`;
const RESEND_OTP_DELAY_SECONDS = 30;

/** @type {CountryOption[]} */
const COUNTRY_OPTIONS = [
  {
    code: "AE",
    apiCode: "ae",
    dialCode: "+971",
    name: "United Arab Emirates",
    registrationStoreCode: "ECAE-D",
    registrationCountryCode: "ae",
    phonePlaceholder: "50 123 4567",
    maxDigits: 9,
    validate: (/** @type {string} */ digits) => /^5\d{8}$/.test(digits),
    errorMessage: "Enter a valid UAE mobile number.",
  },
  {
    code: "SA",
    apiCode: "sa",
    dialCode: "+966",
    name: "Saudi Arabia",
    registrationStoreCode: "ECAE-D",
    registrationCountryCode: "ae",
    phonePlaceholder: "50 123 4567",
    maxDigits: 9,
    validate: (/** @type {string} */ digits) => /^5\d{8}$/.test(digits),
    errorMessage: "Enter a valid Saudi mobile number starting with 5.",
  },
  {
    code: "CA",
    apiCode: "ca",
    dialCode: "+1",
    name: "Canada",
    registrationStoreCode: "ECAE-D",
    registrationCountryCode: "ae",
    phonePlaceholder: "604 123 4567",
    maxDigits: 10,
    validate: (/** @type {string} */ digits) => /^[2-9]\d{9}$/.test(digits),
    errorMessage: "Enter a valid 10 digit Canadian mobile number.",
  },
  {
    code: "IN",
    apiCode: "in",
    dialCode: "+91",
    name: "India",
    registrationStoreCode: "ECAE-D",
    registrationCountryCode: "ae",
    phonePlaceholder: "98765 43210",
    maxDigits: 10,
    validate: (/** @type {string} */ digits) => /^[6-9]\d{9}$/.test(digits),
    errorMessage: "Enter a valid 10 digit Indian mobile number.",
  },
];

/**
 * @param {string=} customerId
 * @returns {ExtensionState}
 */
function createInitialState(customerId) {
  return {
    loading: true,
    screen: "phone",
    linked: false,
    shop: "",
    customerId: customerId ?? "",
    email: "",
    firstName: "",
    lastName: "",
    countryCode: COUNTRY_OPTIONS[0]?.code ?? "AE",
    phone: "",
    otp: "",
    pointBalance: "",
    redeemPoint: "",
    canRedeem: false,
    personQCCode: "",
    loyaltyQCCode: "",
    tier: "",
    loyaltySync: false,
    sendingOtp: false,
    verifyingOtp: false,
    creatingPerson: false,
    activatingAccount: false,
    savingMetafields: false,
    infoMessage: "",
    errorMessage: "",
    phoneError: "",
    hasSavedPhone: false,
    resendSecondsLeft: 0,
    needsActivation: false,
    isExistingPerson: false,
    needsPatch: false,
    inactiveMemberships: [],
    otpFlowCompleted: false,
    countryOptions: COUNTRY_OPTIONS,
  };
}

export default async function extension() {
  render(<Extension />, document.body);
}

/**
 * @param {string} countryCode
 * @param {CountryOption[]=} countryOptions
 * @returns {CountryOption}
 */
function getCountryConfig(countryCode, countryOptions = COUNTRY_OPTIONS) {
  return (
    countryOptions.find((country) => country.code === countryCode) ??
    countryOptions[0] ??
    COUNTRY_OPTIONS[0]
  );
}

/**
 * @param {string=} shopCountryCode
 * @param {CountryOption[]=} defaultOptions
 * @returns {CountryOption[]}
 */
function buildCountryOptions(
  shopCountryCode,
  defaultOptions = COUNTRY_OPTIONS,
) {
  const normalized = String(shopCountryCode ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) return defaultOptions;

  const options = [...defaultOptions];
  const existingIndex = options.findIndex(
    (country) => country.code === normalized,
  );

  if (existingIndex === -1) {
    options.unshift({
      code: normalized,
      apiCode: normalized.toLowerCase(),
      dialCode: "",
      name: normalized,
      registrationStoreCode: "",
      registrationCountryCode: normalized.toLowerCase(),
      phonePlaceholder: "",
      maxDigits: 10,
      validate: (/** @type {string} */ _digits) => true,
      errorMessage: "",
    });
  } else if (existingIndex > 0) {
    const [matched] = options.splice(existingIndex, 1);
    options.unshift(matched);
  }

  return options;
}

/**
 * @param {Array<Object>} raw
 * @param {CountryOption[]=} defaultOptions
 * @returns {CountryOption[]}
 */
function normalizeAvailableCountries(raw, defaultOptions = COUNTRY_OPTIONS) {
  if (!Array.isArray(raw) || raw.length === 0) return defaultOptions;

  const nameToCode = {
    Canada: "CA",
    India: "IN",
    "United Arab Emirates": "AE",
    "Saudi Arabia": "SA",
    UAE: "AE",
  };

  const normalizeValue = (value) => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return String(value).trim();
    }
    if (Array.isArray(value)) {
      return value.map(normalizeValue).filter(Boolean).join(" ");
    }
    if (value && typeof value === "object") {
      const objectValue = value;
      return normalizeValue(
        objectValue.name ??
          objectValue.label ??
          objectValue.value ??
          objectValue.code ??
          "",
      );
    }
    return "";
  };

  const options = raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const itemObj = item;

      const name = normalizeValue(
        itemObj.name ?? itemObj.country ?? itemObj.label ?? itemObj.value ?? "",
      );
      if (!name) return null;

      const found = defaultOptions.find(
        (c) =>
          c.name.toLowerCase() === name.toLowerCase() ||
          c.code.toLowerCase() === name.toLowerCase() ||
          c.apiCode.toLowerCase() === name.toLowerCase(),
      );
      if (found) return found;

      const codeFromItem =
        normalizeValue(itemObj.code ?? itemObj.apiCode).toUpperCase() ||
        undefined;
      const codeFromName = nameToCode[name];
      const code =
        codeFromItem || codeFromName || name.slice(0, 2).toUpperCase();
      return {
        code,
        apiCode: code.toLowerCase(),
        dialCode: normalizeValue(itemObj.dialCode) || "",
        name,
        registrationStoreCode:
          normalizeValue(itemObj.registrationStoreCode) || "",
        registrationCountryCode:
          normalizeValue(itemObj.registrationCountryCode) ||
          code.toLowerCase() ||
          "ae",
        phonePlaceholder: normalizeValue(itemObj.phonePlaceholder) || "",
        maxDigits:
          typeof itemObj.maxDigits === "number" ? itemObj.maxDigits : 10,
        validate: (_digits) => true,
        errorMessage: "",
      };
    })
    .filter(Boolean);

  return options.length ? options : defaultOptions;
}

/**
 * @param {string} value
 * @param {string} countryCode
 * @param {CountryOption[]=} countryOptions
 * @returns {string}
 */
function sanitizePhoneInput(
  value,
  countryCode,
  countryOptions = COUNTRY_OPTIONS,
) {
  const country = getCountryConfig(countryCode, countryOptions);
  return value.replace(/\D/g, "").slice(0, country.maxDigits);
}

/**
 * @param {string} phone
 * @param {string} countryCode
 * @param {CountryOption[]=} countryOptions
 * @returns {string}
 */
function validatePhone(phone, countryCode, countryOptions = COUNTRY_OPTIONS) {
  const country = getCountryConfig(countryCode, countryOptions);
  const digits = sanitizePhoneInput(phone, countryCode, countryOptions);
  if (!digits) return "Please enter your mobile number.";
  if (digits.length !== country.maxDigits || !country.validate(digits)) {
    return country.errorMessage;
  }
  return "";
}

/**
 * @param {string} phone
 * @param {string} savedCountryCode
 * @param {CountryOption[]=} countryOptions
 * @returns {string}
 */
function inferCountryFromPhone(
  phone,
  savedCountryCode,
  countryOptions = COUNTRY_OPTIONS,
) {
  if (savedCountryCode) {
    return getCountryConfig(savedCountryCode.toUpperCase(), countryOptions)
      .code;
  }
  const normalizedPhone = typeof phone === "string" ? phone.trim() : "";
  if (normalizedPhone.startsWith("+971")) return "AE";
  if (normalizedPhone.startsWith("+966")) return "SA";
  if (normalizedPhone.startsWith("+91")) return "IN";
  return countryOptions[0]?.code ?? COUNTRY_OPTIONS[0]?.code ?? "AE";
}

/**
 * @param {string} phone
 * @param {string} countryCode
 * @param {CountryOption[]=} countryOptions
 * @returns {string}
 */
function normalizeStoredPhone(
  phone,
  countryCode,
  countryOptions = COUNTRY_OPTIONS,
) {
  if (!phone) return "";
  const country = getCountryConfig(countryCode, countryOptions);
  const digits = phone.replace(/\D/g, "");
  const dialDigits = country.dialCode.replace("+", "");
  if (digits.startsWith(dialDigits)) {
    return digits.slice(dialDigits.length).slice(-country.maxDigits);
  }
  return digits.slice(-country.maxDigits);
}

/**
 * @param {string=} value
 * @returns {string}
 */
function normalizeShopDomain(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^https?:\/\//, "").split("/")[0] || "";
}

/**
 * @param {string} token
 * @returns {string}
 */
function getShopFromSessionToken(token) {
  try {
    const payloadPart = String(token || "").split(".")[1];
    if (!payloadPart) return "";
    const paddedPayload = payloadPart.padEnd(
      Math.ceil(payloadPart.length / 4) * 4,
      "=",
    );
    const payload = JSON.parse(
      globalThis.atob(paddedPayload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return normalizeShopDomain(payload?.dest || payload?.iss || payload?.aud);
  } catch (e) {
    return "";
  }
}

/**
 * @param {string=} fallbackShop
 * @returns {Promise<string>}
 */
async function resolveShopForRequest(fallbackShop) {
  const normalizedFallback = normalizeShopDomain(fallbackShop);
  if (normalizedFallback) return normalizedFallback;

  try {
    const idToken = await globalThis.shopify?.sessionToken?.get?.();
    return getShopFromSessionToken(idToken);
  } catch (e) {
    return "";
  }
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatSeconds(seconds) {
  return `${String(seconds).padStart(2, "0")}s`;
}

/**
 * @param {string} shop
 * @param {string} phone
 * @returns {string}
 */
function getOtpStorageKey(shop, phone) {
  const shopId = shop ? String(shop) : "no-shop";
  const phoneId = phone ? String(phone) : "no-phone";
  return `beu_otp:${shopId}:${phoneId}`;
}

/**
 * @param {string} shop
 * @param {string} phone
 * @param {number} ttlSeconds
 * @returns {void}
 */
function saveOtpSession(shop, phone, ttlSeconds) {
  try {
    const key = getOtpStorageKey(shop, phone);
    const payload = {
      expires: Date.now() + (ttlSeconds || RESEND_OTP_DELAY_SECONDS) * 1000,
    };
    sessionStorage.setItem(key, JSON.stringify(payload));
  } catch (e) {}
}

/**
 * @param {string} shop
 * @param {string} phone
 * @returns {OtpSession | null}
 */
function readOtpSession(shop, phone) {
  try {
    const key = getOtpStorageKey(shop, phone);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return /** @type {OtpSession} */ (JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

/**
 * @returns {Array<{name: string, flag: boolean, metadata: Array<{key: string, value: string}>}>}
 */
function buildConsentList() {
  return [
    {
      name: "EMAIL",
      flag: true,
      metadata: [
        { key: "User-Agent", value: "Ecommerce" },
        { key: "Source", value: "Shopify" },
      ],
    },
    {
      name: "SMS",
      flag: true,
      metadata: [
        { key: "User-Agent", value: "Ecommerce" },
        { key: "Source", value: "Shopify" },
      ],
    },
  ];
}

/**
 * @param {CountryOption} country
 * @param {boolean} canRedeem
 * @returns {Array<Object>}
 */
function buildLoyaltyMembershipData(country, canRedeem) {
  return [
    {
      schemaCode: "0000",
      registrationStoreCode: country.registrationStoreCode || "ECAE-D",
      registrationCountryCode: country.registrationCountryCode || "ae",
      category: "WHITE",
      registrationSource: "WEBSITE",
      loyaltyCardData: { type: "Permanent" },
      attributes: [
        {
          attributeName: "CANREDEEM",
          attributeValue: canRedeem ? "true" : "false",
          dataType: "BOOLEAN",
        },
      ],
    },
  ];
}

/**
 * @param {ExtensionState} state
 * @param {CountryOption} selectedCountry
 * @returns {MetafieldRow[]}
 */
function buildMetafieldRows(state, selectedCountry) {
  return [
    { label: "Email", value: state.email },
    { label: "Country", value: selectedCountry.name },
    {
      label: "Phone",
      value: state.phone ? `${selectedCountry.dialCode} ${state.phone}` : "",
    },
    { label: "Person QC Code", value: state.personQCCode },
    { label: "Loyalty QC Code", value: state.loyaltyQCCode },
    { label: "Tier", value: state.tier },
    { label: "Redeem Point", value: state.redeemPoint || state.pointBalance },
    { label: "Can Redeem", value: state.canRedeem === true ? "Yes" : "No" },
    { label: "Loyalty Sync", value: state.loyaltySync === true ? "Yes" : "No" },
  ].filter((item) => item.value);
}

function Extension() {
  const currentCustomerId =
    globalThis.shopify?.authenticatedAccount?.customer?.value?.id ?? "";
  const [state, setState] = useState(() =>
    createInitialState(currentCustomerId),
  );

  /**
   * @param {{allowQivosBackfill?: boolean}=} options
   */
  async function fetchCustomerMetafields(options = {}) {
    const stringify = (val) => {
      if (typeof val === "string") return val;
      if (!val) return "";
      return (
        val.message ||
        val.description ||
        val.desc ||
        val.error ||
        (typeof val === "object" ? JSON.stringify(val) : String(val))
      );
    };

    const customer =
      globalThis.shopify?.authenticatedAccount?.customer?.value ?? {};
    const customerId = customer.id ?? "";
    const firstName = customer.firstName ?? "";
    const lastName = customer.lastName ?? "";

    if (!customerId) {
      setState((prev) => ({
        ...prev,
        loading: false,
        errorMessage: "Customer account not found.",
      }));
      return { linked: false, loyaltySync: false };
    }

    const idToken = await globalThis.shopify.sessionToken.get();
    const shopFromToken = getShopFromSessionToken(idToken);
    const url = new URL(CUSTOMER_METAFIELDS_ENDPOINT);
    url.searchParams.set("customerId", customerId);
    if (options.allowQivosBackfill) {
      url.searchParams.set("allowQivosBackfill", "1");
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${idToken}`,
      },
    });

    /** @type {CustomerMetafieldsResponse} */
    const result = await response.json();

    if (!response.ok || result.ok === false) {
      throw new Error(
        stringify(result.error) ||
          `Failed to load customer metafields (${response.status})`,
      );
    }

    const rawAvailableCountries =
      Array.isArray(result.availableCountries) &&
      result.availableCountries.length > 0
        ? result.availableCountries
        : Array.isArray(result.shopCountryCode) &&
            result.shopCountryCode.length > 0
          ? result.shopCountryCode
          : null;
    const availableCountries = rawAvailableCountries
      ? normalizeAvailableCountries(rawAvailableCountries)
      : buildCountryOptions(
          typeof result.shopCountryCode === "string"
            ? result.shopCountryCode
            : undefined,
        );

    const rawPhone = result.phone ?? "";
    const inferredCountryCode = inferCountryFromPhone(
      rawPhone,
      result.countryCode ?? "",
      availableCountries,
    );
    const countryCode = availableCountries.find(
      (c) => c.code === inferredCountryCode,
    )
      ? inferredCountryCode
      : (availableCountries[0]?.code ?? COUNTRY_OPTIONS[0]?.code ?? "AE");

    const phone = normalizeStoredPhone(
      rawPhone,
      countryCode,
      availableCountries,
    );
    const hasSavedPhone = Boolean(
      rawPhone && !validatePhone(phone, countryCode, availableCountries),
    );
    const needsActivation =
      Array.isArray(result.inactiveMemberships) &&
      result.inactiveMemberships.length > 0;

    const canRedeem = result.canRedeem === true;

    const linked =
      !needsActivation &&
      result.loyaltySync === true &&
      Boolean(result.personQCCode && result.loyaltyQCCode && rawPhone);

    setState((prev) => ({
      ...prev,
      loading: false,
      screen: linked ? "success" : prev.screen === "otp" ? "otp" : "phone",
      linked: linked,
      shop: normalizeShopDomain(result.shop) || shopFromToken || prev.shop,
      customerId,
      email: result.email ?? "",
      firstName,
      lastName,
      countryCode,
      countryOptions: availableCountries,
      phone: hasSavedPhone ? phone : prev.phone,
      pointBalance: result.redeemPoint ?? result.pointBalance ?? "",
      redeemPoint: result.redeemPoint ?? result.pointBalance ?? "",
      canRedeem,
      personQCCode: result.personQCCode ?? "",
      loyaltyQCCode: result.loyaltyQCCode ?? "",
      tier: result.tier ?? "",
      loyaltySync: result.loyaltySync === true,
      infoMessage: linked ? "Your Be U account is linked." : prev.infoMessage,
      errorMessage: "",
      phoneError: "",
      hasSavedPhone,
      needsActivation,
      inactiveMemberships: Array.isArray(result.inactiveMemberships)
        ? result.inactiveMemberships
        : [],
      otpFlowCompleted: linked || prev.otpFlowCompleted,
    }));

    return {
      linked,
      loyaltySync: result.loyaltySync === true,
      shop: normalizeShopDomain(result.shop) || shopFromToken || undefined,
      phone: hasSavedPhone ? phone : undefined,
      customerId,
      personQCCode: result.personQCCode,
      loyaltyQCCode: result.loyaltyQCCode,
      pointBalance: result.redeemPoint ?? result.pointBalance,
      canRedeem: result.canRedeem,
      tier: result.tier,
      qivosBackfillApplied: result.qivosBackfillApplied === true,
      qivosBackfillRequired: result.qivosBackfillRequired === true,
      inactiveMemberships: Array.isArray(result.inactiveMemberships)
        ? result.inactiveMemberships
        : [],
    };
  }

  async function convertToCredit() {
    const shopifyCustomerId =
      globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
      state.customerId ??
      "";
    const requestShop = await resolveShopForRequest(state.shop);
    const points = parseInt(state.redeemPoint || state.pointBalance || "0", 10);

    if (!points || points <= 0) return;

    setState((prev) => ({
      ...prev,
      convertingToCredit: true,
      errorMessage: "",
      infoMessage: "",
    }));

    try {
      await postJson(CUSTOMER_CREDIT_ENDPOINT, {
        shop: requestShop,
        customerId: shopifyCustomerId,
        redeemPoints: points,
      });

      // Refresh metafields to get updated point balance
      const refreshed = await fetchCustomerMetafields();

      setState((prev) => ({
        ...prev,
        convertingToCredit: false,
        infoMessage: `Successfully converted ${points} points to store credit!`,
        pointBalance: refreshed.pointBalance ?? "",
        redeemPoint: refreshed.pointBalance ?? "",
        canRedeem: refreshed.canRedeem ?? prev.canRedeem,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        convertingToCredit: false,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Failed to convert points to credit.",
      }));
    }
  }
  /**
   * Save metafields to backend
   * @param {Partial<ExtensionState>=} updates
   * @returns {Promise<boolean>}
   */
  async function saveCustomerMetafields(updates = {}) {
    try {
      const idToken = await globalThis.shopify.sessionToken.get();
      const requestShop = await resolveShopForRequest(state.shop);

      const customerId =
        globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
        state.customerId ??
        "";

      if (!customerId) {
        console.warn("Cannot save metafields: No customer ID");
        return false;
      }

      setState((prev) => ({
        ...prev,
        savingMetafields: true,
      }));

      const url = new URL(CUSTOMER_METAFIELDS_ENDPOINT);
      url.searchParams.set("customerId", customerId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          shop: requestShop,
          customerId,
          email: updates.email ?? state.email,
          phone: updates.phone ?? state.phone,
          countryCode: updates.countryCode ?? state.countryCode,
          firstName: updates.firstName ?? state.firstName,
          lastName: updates.lastName ?? state.lastName,
          personQCCode: updates.personQCCode ?? state.personQCCode,
          loyaltyQCCode: updates.loyaltyQCCode ?? state.loyaltyQCCode,
          pointBalance: updates.pointBalance ?? state.pointBalance,
          redeemPoint: updates.redeemPoint ?? state.redeemPoint,
          canRedeem:
            updates.canRedeem !== undefined
              ? updates.canRedeem
              : state.canRedeem,
          tier: updates.tier ?? state.tier,
          loyaltySync:
            updates.loyaltySync !== undefined
              ? updates.loyaltySync
              : state.loyaltySync,
        }),
      });

      const result = await response.json();

      setState((prev) => ({
        ...prev,
        savingMetafields: false,
      }));

      return result.ok === true || response.ok;
    } catch (error) {
      console.error("Failed to save metafields:", error);
      setState((prev) => ({
        ...prev,
        savingMetafields: false,
      }));
      return false;
    }
  }

  useEffect(() => {
    if (state.screen !== "otp" || state.resendSecondsLeft <= 0)
      return undefined;
    const timer = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        resendSecondsLeft: Math.max(prev.resendSecondsLeft - 1, 0),
      }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.screen, state.resendSecondsLeft]);

  useEffect(() => {
    let active = true;

    async function loadCustomerMetafields() {
      try {
        if (!active) return;

        const refreshed = await fetchCustomerMetafields();

        const resolvedShop = refreshed.shop ?? state.shop;
        const resolvedPhone = refreshed.phone ?? state.phone;

        if (refreshed.linked) {
          if (refreshed.qivosBackfillRequired) {
            setState((prev) => ({
              ...prev,
              screen: "phone",
              linked: false,
              otpFlowCompleted: false,
              infoMessage:
                "Please verify your phone number to update your Be U profile details.",
              loading: false,
            }));
          } else {
            setState((prev) => ({
              ...prev,
              screen: "success",
              linked: true,
              otpFlowCompleted: true,
              loading: false,
            }));
          }
          return;
        }

        const otpSession = readOtpSession(resolvedShop, resolvedPhone);
        if (otpSession && typeof otpSession.expires === "number") {
          const secondsLeft = Math.max(
            0,
            Math.ceil((otpSession.expires - Date.now()) / 1000),
          );
          if (secondsLeft > 0) {
            setState((prev) => ({
              ...prev,
              screen: "otp",
              resendSecondsLeft: Math.min(
                RESEND_OTP_DELAY_SECONDS,
                secondsLeft,
              ),
              loading: false,
            }));
          } else {
            try {
              sessionStorage.removeItem(
                getOtpStorageKey(resolvedShop, resolvedPhone),
              );
            } catch (e) {}
            setState((prev) => ({
              ...prev,
              loading: false,
            }));
          }
        }

        setState((prev) => ({
          ...prev,
          loading: false,
        }));
      } catch (error) {
        if (!active) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Unable to load account status.",
        }));
      }
    }

    loadCustomerMetafields();
    return () => {
      active = false;
    };
  }, []);

  async function postJson(url, body, method = "POST") {
    const response = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let result = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { raw: text };
    }

    if (!response.ok || result?.success === false) {
      const stringify = (val) => {
        if (typeof val === "string") return val;
        if (!val) return "";
        return (
          val.message ||
          val.description ||
          val.desc ||
          val.error ||
          (typeof val === "object" ? JSON.stringify(val) : String(val))
        );
      };

      // QIVOS often returns errors in a 'messages' array
      let qivosErrorMessage = "";
      if (Array.isArray(result?.messages)) {
        qivosErrorMessage = result.messages
          .map((m) => {
            if (typeof m === "string") return m;
            if (!m) return "";
            return (
              m.description ||
              m.desc ||
              m.message ||
              (typeof m === "object" ? JSON.stringify(m) : String(m))
            );
          })
          .filter(Boolean)
          .join(" ");
      }

      const message =
        qivosErrorMessage ||
        stringify(result?.error) ||
        stringify(result?.message) ||
        result?.raw ||
        `Request failed (${response.status})`;
      throw new Error(message);
    }
    return result;
  }

  function setPhoneValidationError() {
    const phoneError = validatePhone(
      state.phone,
      state.countryCode,
      state.countryOptions,
    );
    if (phoneError) {
      setState((prev) => ({
        ...prev,
        phoneError,
        errorMessage: "",
        infoMessage: "",
      }));
      return null;
    }
    return sanitizePhoneInput(
      state.phone,
      state.countryCode,
      state.countryOptions,
    );
  }

  async function sendOtp() {
    const mobileNumber = setPhoneValidationError();
    if (!mobileNumber) return;

    const country = getCountryConfig(state.countryCode, state.countryOptions);
    const requestShop = await resolveShopForRequest(state.shop);

    setState((prev) => ({
      ...prev,
      shop: requestShop || prev.shop,
      sendingOtp: true,
      errorMessage: "",
      infoMessage: "",
      phoneError: "",
    }));

    try {
      const shopifyCustomerId =
        globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
        state.customerId ??
        "";

      // 1. First check if the phone number is already in use by another account
      const checkResult = await postJson(CUSTOMER_SEARCH_ENDPOINT, {
        shop: requestShop,
        telephoneNumber: mobileNumber,
        countryCode: country.apiCode,
        customerId: shopifyCustomerId,
      });

      const phoneCheck = checkResult.phoneCheck || {};

      // Determine if person exists and needs profile patching
      const isExisting = !!checkResult.personQCCode;
      const needsPatch = !!(
        isExisting &&
        (!checkResult.firstName || !checkResult.lastName || !checkResult.email)
      );

      // 2. Proceed with sending OTP
      await postJson(SEND_OTP_ENDPOINT, {
        shop: requestShop,
        mobileNumber,
        countryCode: country.apiCode,
      });

      saveOtpSession(requestShop, mobileNumber, RESEND_OTP_DELAY_SECONDS);

      setState((prev) => ({
        ...prev,
        shop: requestShop || prev.shop,
        phone: mobileNumber,
        screen: "otp",
        sendingOtp: false,
        isExistingPerson: isExisting,
        needsPatch: needsPatch,
        personQCCode: checkResult.personQCCode || prev.personQCCode,
        loyaltyQCCode: checkResult.loyaltyQCCode || prev.loyaltyQCCode,
        pointBalance: checkResult.pointBalance || prev.pointBalance,
        redeemPoint: checkResult.redeemPoint || prev.redeemPoint,
        canRedeem: checkResult.canRedeem ?? prev.canRedeem,
        tier: checkResult.tier || prev.tier,
        infoMessage: "OTP sent successfully.",
        errorMessage: "",
        phoneError: "",
        resendSecondsLeft: RESEND_OTP_DELAY_SECONDS,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        sendingOtp: false,
        infoMessage: "",
        errorMessage:
          error instanceof Error ? error.message : "Failed to send OTP.",
      }));
    }
  }

  async function createPerson() {
    const country = getCountryConfig(state.countryCode, state.countryOptions);
    const shopifyCustomerId =
      globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
      state.customerId ??
      "";
    const requestShop = await resolveShopForRequest(state.shop);

    setState((prev) => ({
      ...prev,
      shop: requestShop || prev.shop,
      creatingPerson: true,
      errorMessage: "",
      infoMessage: "Creating a new Be U registration...",
    }));

    try {
      await postJson(PERSONS_ENDPOINT, {
        shop: requestShop,
        customerId: shopifyCustomerId,
        email: state.email,
        countryCode: country.code,
        phone: state.phone,
        firstName: state.firstName,
        lastName: state.lastName,
        registrationSource: "WEBSITE",
        registrationStoreCode: country.registrationStoreCode || "ECAE-D",
        telephoneList: [
          {
            countryCode: country.code,
            telephoneNumber: state.phone,
            telephoneType: "MOBILE",
            isPrimary: true,
            attributes: [
              {
                attributeName: "HASVERIFIEDMOBILE",
                attributeValue: "true",
                dataType: "BOOLEAN",
              },
            ],
          },
        ],
        loyaltyMembershipData: buildLoyaltyMembershipData(
          country,
          state.canRedeem,
        ),
        consentList: buildConsentList(),
        ...(state.email
          ? { emailList: [{ emailAddress: state.email, isPrimary: true }] }
          : {}),
      });

      const refreshed = await fetchCustomerMetafields();

      // ✅ Save metafields after person creation
      await saveCustomerMetafields({
        personQCCode: refreshed.personQCCode,
        loyaltyQCCode: refreshed.loyaltyQCCode,
        loyaltySync: refreshed.loyaltySync,
        pointBalance: refreshed.pointBalance,
        redeemPoint: refreshed.pointBalance,
        canRedeem: refreshed.canRedeem,
        tier: refreshed.tier,
      });

      setState((prev) => ({
        ...prev,
        creatingPerson: false,
        linked: refreshed.linked,
        screen: refreshed.linked ? "success" : "phone",
        otpFlowCompleted: refreshed.linked,
        infoMessage: refreshed.linked
          ? "Your Be U account has been linked successfully."
          : "",
        errorMessage: "",
        hasSavedPhone: true,
        loyaltySync: refreshed.loyaltySync,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        creatingPerson: false,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Failed to create Be U account.",
      }));
    }
  }

  async function verifyOtp() {
    const otp = state.otp.trim();
    const shopifyCustomerId =
      globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
      state.customerId ??
      "";

    if (!otp) {
      setState((prev) => ({
        ...prev,
        errorMessage: "Please enter the verification code.",
        infoMessage: "",
      }));
      return;
    }

    const country = getCountryConfig(state.countryCode, state.countryOptions);
    const requestShop = await resolveShopForRequest(state.shop);

    setState((prev) => ({
      ...prev,
      shop: requestShop || prev.shop,
      verifyingOtp: true,
      errorMessage: "",
      infoMessage: "Verifying your OTP...",
    }));

    try {
      await postJson(VALIDATE_OTP_ENDPOINT, {
        shop: requestShop,
        mobileNumber: state.phone,
        oneTimePin: otp,
        countryCode: country.apiCode,
      });

      try {
        sessionStorage.removeItem(getOtpStorageKey(requestShop, state.phone));
      } catch (e) {}

      setState((prev) => ({
        ...prev,
        infoMessage: "Validating your Be U profile details...",
      }));

      // If it's an existing person with missing profile data, patch them now
      if (state.isExistingPerson && state.needsPatch && state.personQCCode) {
        const detailsUrl = `${PERSONS_ENDPOINT}/${encodeURIComponent(state.personQCCode)}/details`;

        await postJson(
          detailsUrl,
          {
            shop: requestShop,
            customerId: shopifyCustomerId,
            firstName: state.firstName,
            lastName: state.lastName,
            email: state.email,
            personQCCode: state.personQCCode,
            loyaltySync: true,
          },
          "PUT",
        );
      }

      const refreshed = await fetchCustomerMetafields({
        allowQivosBackfill: true,
      });
      const refreshedInactiveMemberships = Array.isArray(
        refreshed.inactiveMemberships,
      )
        ? refreshed.inactiveMemberships
        : [];
      const activationMode =
        state.needsActivation || refreshedInactiveMemberships.length > 0;

      if (activationMode) {
        setState((prev) => ({
          ...prev,
          verifyingOtp: false,
          linked: false,
          screen: "activation",
          otpFlowCompleted: false,
          needsActivation: true,
          inactiveMemberships:
            refreshedInactiveMemberships.length > 0
              ? refreshedInactiveMemberships
              : prev.inactiveMemberships,
          infoMessage:
            'Account needs activation. Please tap "Activate my account".',
          errorMessage: "",
        }));
        return;
      }

      if (refreshed.linked || state.isExistingPerson) {
        // ✅ Save metafields after OTP verification
        await saveCustomerMetafields({
          personQCCode: refreshed.personQCCode,
          loyaltyQCCode: refreshed.loyaltyQCCode,
          loyaltySync: true,
          pointBalance: refreshed.pointBalance,
          redeemPoint: refreshed.pointBalance,
          canRedeem: refreshed.canRedeem,
          tier: refreshed.tier,
        });

        setState((prev) => ({
          ...prev,
          verifyingOtp: false,
          linked: true,
          screen: "success",
          otpFlowCompleted: true,
          loyaltySync: true,
          infoMessage: refreshed.qivosBackfillApplied
            ? "OTP verified successfully. Your Be U profile details were updated."
            : "OTP verified successfully.",
          errorMessage: "",
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        verifyingOtp: false,
        infoMessage:
          "OTP verified successfully. Creating your Be U registration next...",
        errorMessage: "",
      }));

      await createPerson();
    } catch (error) {
      setState((prev) => ({
        ...prev,
        verifyingOtp: false,
        errorMessage:
          error instanceof Error ? error.message : "OTP verification failed.",
      }));
    }
  }

  async function activateInactiveMemberships() {
    if (!state.needsActivation) {
      return;
    }
    const shopifyCustomerId =
      globalThis.shopify?.authenticatedAccount?.customer?.value?.id ??
      state.customerId ??
      "";
    const requestShop = await resolveShopForRequest(state.shop);
    const membershipsToActivate =
      state.inactiveMemberships.length > 0
        ? state.inactiveMemberships
        : state.personQCCode && state.loyaltyQCCode
          ? [
              {
                personQCCode: state.personQCCode,
                loyaltyQCCode: state.loyaltyQCCode,
              },
            ]
          : [];

    if (membershipsToActivate.length === 0) {
      setState((prev) => ({
        ...prev,
        errorMessage:
          "Missing Person QC Code or Loyalty QC Code for activation.",
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      shop: requestShop || prev.shop,
      activatingAccount: true,
      errorMessage: "",
      infoMessage: "",
    }));

    try {
      for (const membership of membershipsToActivate) {
        const statusUrl = `${APP_URL}/api/proxy/persons/${encodeURIComponent(
          membership.personQCCode,
        )}/loyalty-membership/${encodeURIComponent(
          membership.loyaltyQCCode,
        )}/status`;

        await postJson(statusUrl, {
          shop: requestShop,
          customerId: shopifyCustomerId,
          personQCCode: membership.personQCCode,
          loyaltyQCCode: membership.loyaltyQCCode,
          active: true,
        });
      }

      // ✅ Save metafields after activation
      await saveCustomerMetafields({
        loyaltySync: true,
        needsActivation: false,
      });

      setState((prev) => ({
        ...prev,
        activatingAccount: false,
        needsActivation: false,
        inactiveMemberships: [],
        linked: true,
        screen: "success",
        otpFlowCompleted: true,
        infoMessage: "Your account has been activated successfully.",
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        activatingAccount: false,
        errorMessage:
          error instanceof Error ? error.message : "Account activation failed.",
      }));
    } finally {
      setState((prev) => ({
        ...prev,
        activatingAccount: false,
      }));
    }
  }

  function handleCountryChange(event) {
    const target = event.currentTarget;
    const nextCountryCode = String(target.value);
    setState((prev) => ({
      ...prev,
      countryCode: nextCountryCode,
      phone: sanitizePhoneInput(
        prev.phone,
        nextCountryCode,
        prev.countryOptions,
      ),
      phoneError: "",
      errorMessage: "",
      infoMessage: "",
      hasSavedPhone: false,
    }));
  }

  function handlePhoneInput(event) {
    const target = event.currentTarget;
    const nextPhone = sanitizePhoneInput(
      target.value,
      state.countryCode,
      state.countryOptions,
    );
    setState((prev) => ({
      ...prev,
      phone: nextPhone,
      phoneError: "",
      errorMessage: "",
      infoMessage: "",
      hasSavedPhone: false,
    }));
  }

  function handleOtpChange(event) {
    const target = event.currentTarget;
    setState((prev) => ({
      ...prev,
      otp: target.value,
      errorMessage: "",
    }));
  }

  const selectedCountry = getCountryConfig(
    state.countryCode,
    state.countryOptions,
  );
  const metafieldRows = buildMetafieldRows(state, selectedCountry);

  if (state.loading) {
    return (
      <s-box padding="large">
        <s-stack direction="block" alignItems="center">
          <s-text>Loading Be U loyalty status...</s-text>
        </s-stack>
      </s-box>
    );
  }

  if (state.screen === "activation") {
    return (
      <s-box padding="large">
        <s-stack direction="block" gap="large" alignItems="center">
          <s-box maxInlineSize="640px" inlineSize="100%">
            <s-stack direction="block" gap="large">
              <s-heading>Be U loyalty</s-heading>
              <s-banner tone="warning" heading="Account needs activation">
                <s-text>
                  We found an inactive Be U membership on your account. Tap the
                  button below to activate it.
                </s-text>
              </s-banner>
              {state.infoMessage ? (
                <s-banner tone="warning">
                  <s-text>{state.infoMessage}</s-text>
                </s-banner>
              ) : null}
              <s-button
                onClick={activateInactiveMemberships}
                disabled={state.activatingAccount}
              >
                {state.activatingAccount
                  ? "Activating..."
                  : "Activate my account"}
              </s-button>
            </s-stack>
          </s-box>
        </s-stack>
      </s-box>
    );
  }

  if (state.screen === "success" || (state.linked && state.otpFlowCompleted)) {
    return (
      <s-box padding="large">
        <s-stack direction="block" gap="large" alignItems="center">
          <s-box maxInlineSize="640px" inlineSize="100%">
            <s-stack direction="block" gap="large">
              <s-heading>Be U loyalty</s-heading>

              <s-banner tone="success" heading="🎉 Congratulations!">
                <s-text>
                  Your Be U loyalty account has been successfully linked! You
                  can now enjoy all your loyalty benefits.
                </s-text>
              </s-banner>

              {state.infoMessage ? (
                <s-banner tone="success">
                  <s-text>{state.infoMessage}</s-text>
                </s-banner>
              ) : null}

              {state.redeemPoint ||
              state.pointBalance ||
              state.tier ||
              state.loyaltySync ||
              state.canRedeem !== undefined ? (
                <s-box
                  borderWidth="base"
                  borderRadius="base"
                  padding="large"
                  background="subdued"
                >
                  <s-stack direction="block" gap="base">
                    <s-text>Account summary</s-text>
                    <s-grid
                      gap="base"
                      gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
                    >
                      {state.redeemPoint || state.pointBalance ? (
                        <s-grid-item>
                          <s-stack direction="block" gap="small-100">
                            <s-text>Redeem points</s-text>
                            <s-heading>
                              {state.redeemPoint || state.pointBalance} Points
                            </s-heading>
                          </s-stack>
                        </s-grid-item>
                      ) : null}
                    </s-grid>
                    <s-button
                      onClick={convertToCredit}
                      disabled={
                        state.convertingToCredit ||
                        !state.canRedeem ||
                        !(
                          parseInt(
                            state.redeemPoint || state.pointBalance || "0",
                            10,
                          ) > 0
                        )
                      }
                    >
                      {state.convertingToCredit
                        ? "Converting..."
                        : "Convert to Credit"}
                    </s-button>
                  </s-stack>
                </s-box>
              ) : null}

              {metafieldRows.length ? (
                <s-box
                  borderWidth="base"
                  borderRadius="base"
                  padding="large"
                  background="subdued"
                >
                  <s-stack direction="block" gap="base">
                    <s-text>Customer details</s-text>
                    {metafieldRows.map((item) => (
                      <s-grid
                        key={item.label}
                        gap="base"
                        gridTemplateColumns="minmax(140px, 180px) 1fr"
                      >
                        <s-grid-item>
                          <s-text>{item.label}</s-text>
                        </s-grid-item>
                        <s-grid-item>
                          <s-text>{item.value}</s-text>
                        </s-grid-item>
                      </s-grid>
                    ))}
                  </s-stack>
                </s-box>
              ) : null}
            </s-stack>
          </s-box>
        </s-stack>
      </s-box>
    );
  }

  const showCountrySelector = state.countryOptions.length > 1;
  const showPhoneInput = !state.hasSavedPhone;

  return (
    <s-box padding="large">
      <s-stack direction="block" gap="large" alignItems="center">
        <s-box maxInlineSize="640px" inlineSize="100%">
          <s-stack direction="block" gap="large">
            <s-heading>Be U loyalty</s-heading>
            <s-text>
              {state.screen === "otp"
                ? "Please enter the verification code sent to your phone number."
                : state.screen === "activation"
                  ? "Your OTP is verified. Activate your Be U loyalty account to finish linking."
                  : "Enter your mobile number to connect your Be U loyalty account."}
            </s-text>

            {state.needsActivation ? (
              <s-banner tone="warning" heading="Account needs activation">
                <s-text>
                  We found an inactive Be U loyalty membership on your account.
                  Please verify your phone to activate it.
                </s-text>
              </s-banner>
            ) : null}

            {state.screen === "otp" ? (
              <s-box
                borderWidth="base"
                borderRadius="base"
                padding="base"
                background="subdued"
              >
                <s-text>
                  OTP sent to {selectedCountry.dialCode} {state.phone}
                </s-text>
              </s-box>
            ) : (
              <s-grid
                gap="base"
                gridTemplateColumns={
                  showCountrySelector
                    ? "repeat(auto-fit, minmax(220px, 1fr))"
                    : "1fr"
                }
              >
                {showCountrySelector ? (
                  <s-grid-item>
                    <s-select
                      label="Country"
                      value={String(state.countryCode)}
                      onChange={handleCountryChange}
                    >
                      {state.countryOptions.map((country) => (
                        <s-option
                          key={String(country.code)}
                          value={String(country.code)}
                        >
                          {typeof country.name === "string"
                            ? country.name
                            : String(country.name)}
                        </s-option>
                      ))}
                    </s-select>
                  </s-grid-item>
                ) : null}
                <s-grid-item>
                  <s-text-field
                    label="Enter phone number"
                    prefix={selectedCountry.dialCode}
                    value={state.phone}
                    error={state.phoneError || undefined}
                    placeholder={selectedCountry.phonePlaceholder}
                    maxLength={selectedCountry.maxDigits}
                    onInput={handlePhoneInput}
                  ></s-text-field>
                </s-grid-item>
              </s-grid>
            )}

            {state.screen !== "otp" && !showPhoneInput ? (
              <s-box
                borderWidth="base"
                borderRadius="base"
                padding="base"
                background="subdued"
              >
                <s-text>
                  Mobile number found: {selectedCountry.dialCode} {state.phone}.
                  OTP verification is still required.
                </s-text>
              </s-box>
            ) : null}

            {state.screen === "otp" ? (
              <s-text-field
                label="Verification code"
                value={state.otp}
                autocomplete="one-time-code"
                onChange={handleOtpChange}
              ></s-text-field>
            ) : null}

            {state.infoMessage ? (
              <s-banner tone="success">
                <s-text>{state.infoMessage}</s-text>
              </s-banner>
            ) : null}

            {state.errorMessage ? (
              <s-banner tone="warning" heading="Something went wrong">
                <s-text>{state.errorMessage}</s-text>
              </s-banner>
            ) : null}

            <s-stack direction="inline" gap="base">
              {state.screen === "activation" ? (
                <s-button
                  onClick={activateInactiveMemberships}
                  disabled={state.activatingAccount}
                >
                  {state.activatingAccount
                    ? "Activating..."
                    : "Activate my account"}
                </s-button>
              ) : state.screen === "otp" ? (
                <>
                  <s-button
                    onClick={verifyOtp}
                    disabled={
                      state.verifyingOtp ||
                      state.creatingPerson ||
                      state.activatingAccount
                    }
                  >
                    {state.verifyingOtp ||
                    state.creatingPerson ||
                    state.activatingAccount
                      ? "Please wait..."
                      : "Verify OTP"}
                  </s-button>
                  <s-button
                    onClick={sendOtp}
                    disabled={
                      state.sendingOtp ||
                      state.verifyingOtp ||
                      state.creatingPerson ||
                      state.activatingAccount ||
                      state.resendSecondsLeft > 0
                    }
                  >
                    {state.resendSecondsLeft > 0
                      ? `Resend OTP in ${formatSeconds(state.resendSecondsLeft)}`
                      : "Resend OTP"}
                  </s-button>
                </>
              ) : (
                <s-button
                  onClick={sendOtp}
                  disabled={
                    state.sendingOtp ||
                    state.activatingAccount ||
                    state.creatingPerson ||
                    state.verifyingOtp
                  }
                >
                  {state.sendingOtp ||
                  state.activatingAccount ||
                  state.creatingPerson ||
                  state.verifyingOtp
                    ? "Please wait..."
                    : state.needsActivation
                      ? "Send activation code"
                      : "Get verification code"}
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </s-box>
      </s-stack>
    </s-box>
  );
}
