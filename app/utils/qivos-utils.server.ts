/**
 * QIVOS common utility functions for data extraction and normalization
 */

export function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

export function extractObjectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function extractFirstFromArrayField(
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

export function findFirstNestedValue(
  value: unknown,
  candidateKeys: string[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstNestedValue(item, candidateKeys);
      if (nested) {
        return nested;
      }
    }

    return undefined;
  }

  const record = extractObjectRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of candidateKeys) {
    const directValue = extractStringValue(record[key]);
    if (directValue) {
      return directValue;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findFirstNestedValue(nestedValue, candidateKeys);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function normalizeBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

/**
 * Extract person record from QIVOS API response which might be a single record or a list
 */
export function extractQivosPayload(
  responseData: unknown,
): Record<string, unknown> | undefined {
  const root = extractObjectRecord(responseData);
  const payload = extractObjectRecord(root?.payload);

  if (Array.isArray(payload?.data)) {
    // List-style response: { payload: { data: [ personRecord, ... ] } }
    const firstItem = extractObjectRecord((payload!.data as unknown[])[0]);
    return firstItem ?? payload ?? root;
  }

  // Single-record response: { payload: { data: { ... } } }
  const payloadData = extractObjectRecord(payload?.data);
  return payloadData ?? payload ?? root;
}

export function isQivosLogicalFailure(data: unknown): boolean {
  const record = extractObjectRecord(data);
  if (!record) return false;
  // Only treat it as a failure when "success" is explicitly false.
  return record.success === false;
}

export function isBlank(value: string | undefined): boolean {
  return !value || !value.trim();
}
