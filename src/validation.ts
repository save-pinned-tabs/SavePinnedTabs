/** Provides reusable type guards and error-message normalization utilities. */

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Checks whether a value is an array containing only strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item: unknown) => typeof item === 'string');
}

/** Checks whether a value is a finite or infinite integer recognized by JavaScript. */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Extracts a message from error-like values and stringifies all other values. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}
