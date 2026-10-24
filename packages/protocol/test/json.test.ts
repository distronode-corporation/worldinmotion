import { describe, expect, it } from "vitest";
import { hasDuplicateKeys, parseJson } from "../src/index.ts";

describe("hasDuplicateKeys", () => {
  it("finds a repeated key at any depth", () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"a":1,"b":[],"a":2}',
      '{"x":{"b":1,"b":1}}',
      '[1,{"k":0,"k":0}]',
      '{"a":1,"\\u0061":2}',
      '{"q\\"":1,"q\\u0022":2}',
    ]) {
      expect(hasDuplicateKeys(text), text).toBe(true);
    }
  });

  it("ignores repeats that are not keys of the same object", () => {
    for (const text of [
      '{"a":"a","b":"a"}',
      '[{"a":1},{"a":1}]',
      '{"a":{"b":1},"b":2}',
      '{"a":[1,{"a":2}],"b":{}}',
      '{"s":"{\\"a\\":1,\\"a\\":2}"}',
      '{"a":[],"b":[{}],"c":{"d":[{"e":1},{"e":2}]}}',
      '"plain"',
      "5",
      "[]",
      "{}",
      '{ "a" : 1 , "b" : { "a" : 2 } }',
    ]) {
      expect(hasDuplicateKeys(text), text).toBe(false);
    }
  });

  it("throws a SyntaxError for text that is not JSON, an unterminated string included", () => {
    for (const text of ['{"a', '"', '{"a":"b', '{"a\\', '["x\\"]', "{", "", "nope", '{"a":1,}']) {
      expect(() => hasDuplicateKeys(text), text).toThrow(SyntaxError);
    }
  });
});

describe("parseJson", () => {
  it("parses, and refuses invalid JSON and duplicate keys", () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseJson("{")).toEqual({ ok: false, reason: "not_json" });
    expect(parseJson('{"a":1,"a":2}')).toEqual({ ok: false, reason: "duplicate_key" });
  });
});
