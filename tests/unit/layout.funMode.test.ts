import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUN_MODE,
  FUN_MODE_STORAGE_KEY,
  loadFunMode,
  saveFunMode,
  type FunModeStorage,
} from "@/lib/layout/funMode";

function fakeStorage(initial: Record<string, string> = {}): FunModeStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwing: FunModeStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("fun mode preference", () => {
  it("is off with both visuals chosen by default", () => {
    expect(loadFunMode(fakeStorage())).toEqual({ enabled: false, tint: true, wizard: true });
  });

  it("uses the default with no storage at all", () => {
    expect(loadFunMode(null)).toEqual(DEFAULT_FUN_MODE);
    expect(() => saveFunMode(null, DEFAULT_FUN_MODE)).not.toThrow();
  });

  it("remembers every setting under one key", () => {
    const storage = fakeStorage();
    saveFunMode(storage, { enabled: true, tint: false, wizard: true });
    expect(loadFunMode(storage)).toEqual({ enabled: true, tint: false, wizard: true });
    expect(Object.keys(storage.data)).toEqual([FUN_MODE_STORAGE_KEY]);
  });

  it("falls back to the default for malformed or partial values", () => {
    for (const stored of [
      "yes",
      "{",
      "[]",
      '{"enabled":true}',
      '{"enabled":1,"tint":true,"wizard":true}',
    ]) {
      expect(loadFunMode(fakeStorage({ [FUN_MODE_STORAGE_KEY]: stored }))).toEqual(
        DEFAULT_FUN_MODE,
      );
    }
  });

  it("never throws when the storage itself does", () => {
    expect(loadFunMode(throwing)).toEqual(DEFAULT_FUN_MODE);
    expect(() => saveFunMode(throwing, DEFAULT_FUN_MODE)).not.toThrow();
  });
});
