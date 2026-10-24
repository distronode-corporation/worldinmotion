import { fail, ok, type Result } from "./limits.ts";

/**
 * True when any object in a JSON text repeats a key. `JSON.parse` silently keeps the last
 * duplicate, while other parsers keep the first, so two implementations could read the same signed
 * bytes differently. Keys are compared after unescaping (`"a"` and `"\u0061"` are the same key).
 *
 * Throws a `SyntaxError`, as `JSON.parse` does, when the text is not valid JSON.
 */
export function hasDuplicateKeys(text: string): boolean {
  JSON.parse(text);
  return scanForDuplicateKeys(text);
}

/**
 * The scan behind `hasDuplicateKeys`, for text already known to be valid JSON: a token scan, not
 * a parser. On text that is not JSON it may never return (an unterminated string has no end).
 */
function scanForDuplicateKeys(text: string): boolean {
  // One entry per open container: the keys seen so far for an object, null for an array.
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const keys = stack.at(-1);
      if (expectKey && keys) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      expectKey = Boolean(stack.at(-1));
    }
    i++;
  }
  return false;
}

/** `JSON.parse` that never throws and refuses duplicate keys. Reasons: `not_json`, `duplicate_key`. */
export function parseJson(text: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("not_json");
  }
  return scanForDuplicateKeys(text) ? fail("duplicate_key") : ok(value);
}
