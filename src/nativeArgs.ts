/**
 * Type coercion for the arguments of native tool calls.
 *
 * The CLI runs with no tool definitions, so when the model still emits a
 * native `tool_use` for an Alfred tool there is no `input_schema` to type it:
 * every value arrives as a string (`"[...]"`, `"24"`, `"true"`). Alfred's tool
 * validation then rejects them ("tasks must be a non-empty array", "offset
 * must be a number"). This mirrors the host's `coerceParamValue`
 * (packages/core/src/prompt/toolsFallback.ts), which is module-private and
 * lives in a package this plugin does not depend on, so it cannot be imported.
 *
 * Differences from the host on purpose:
 * - plain strings are returned untouched (not trimmed);
 * - quoted JSON strings and `null` are not decoded — only arrays, objects,
 *   numbers and booleans become typed.
 *
 * Known, accepted risk: a text parameter whose whole value looks like a JSON
 * number or boolean (e.g. a title "2026") becomes a number/boolean.
 */

const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** One string value -> its JSON type when it is an array/object/number/boolean. */
export function coerceNativeValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : value;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '[' && last === ']') || (first === '{' && last === '}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON despite the brackets — keep the original text.
    }
  }
  return value;
}

/**
 * The `input` of a native tool call -> an argument object with typed values.
 * Only top-level values are coerced; a whole input sent as a JSON string is
 * decoded first.
 */
export function coerceNativeArgs(input: unknown): Record<string, unknown> {
  let obj: unknown = input ?? {};
  if (typeof obj === 'string') {
    const decoded = coerceNativeValue(obj);
    obj = decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {};
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    out[key] = coerceNativeValue(value);
  }
  return out;
}
