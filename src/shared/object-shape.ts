/**
 * Narrow to a non-null, non-array object without inspecting its fields or
 * requiring a plain prototype. Message and diagnostic schemas remain the
 * caller's responsibility; native Errors and null-prototype objects qualify.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
