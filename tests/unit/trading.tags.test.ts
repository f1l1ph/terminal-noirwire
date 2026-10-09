import { describe, expect, it } from "vitest";
import { generateClientTag, isOwnTag } from "@/lib/trading/tags";

describe("generateClientTag", () => {
  it("produces a 16-character lowercase hex string (64 bits)", () => {
    const tag = generateClientTag(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(tag).toBe("0001020304050607");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a source that does not supply 8 bytes", () => {
    expect(() => generateClientTag(() => new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("produces different tags from different random sources", () => {
    const a = generateClientTag(() => new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]));
    const b = generateClientTag(() => new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]));
    expect(a).not.toBe(b);
  });
});

describe("isOwnTag", () => {
  it("matches a tag this browser placed", () => {
    expect(isOwnTag("abc123", new Set(["abc123", "def456"]))).toBe(true);
  });

  it("does not match a tag from another browser", () => {
    expect(isOwnTag("zzz999", new Set(["abc123"]))).toBe(false);
  });

  it("does not match a missing tag", () => {
    expect(isOwnTag(null, new Set(["abc123"]))).toBe(false);
    expect(isOwnTag(undefined, new Set(["abc123"]))).toBe(false);
  });
});
