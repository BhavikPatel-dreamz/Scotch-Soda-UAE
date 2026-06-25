import {
  extractObjectRecord,
  extractStringValue,
  normalizeBooleanValue,
} from "./qivos-utils.server";
import { extractPersonQCCode } from "./qivos-person-backfill.server";

export function normalizeInactiveValue(value: unknown): boolean {
  if (typeof value === "boolean") return value === false;
  if (typeof value === "string") return value.trim().toLowerCase() === "false";
  if (value && typeof value === "object" && "value" in value) {
    return normalizeInactiveValue((value as { value?: unknown }).value);
  }
  return false;
}

export function extractLoyaltyQCCode(value: unknown): string | undefined {
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

export function collectInactiveLoyaltyMemberships(
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

export { normalizeBooleanValue };
