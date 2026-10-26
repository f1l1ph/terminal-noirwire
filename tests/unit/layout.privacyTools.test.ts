import { describe, expect, it } from "vitest";
import {
  PRIVACY_TOOLS_STORAGE_KEY,
  loadPrivacyTools,
  savePrivacyTools,
  type PrivacyToolsStorage,
} from "@/lib/layout/privacyTools";

function fakeStorage(initial: Record<string, string> = {}): PrivacyToolsStorage & {
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

const throwing: PrivacyToolsStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("privacy tools preference", () => {
  it("is off by default", () => {
    expect(loadPrivacyTools(fakeStorage())).toBe(false);
  });

  it("is off with no storage at all", () => {
    expect(loadPrivacyTools(null)).toBe(false);
    expect(() => savePrivacyTools(null, true)).not.toThrow();
  });

  it("remembers on and off", () => {
    const storage = fakeStorage();
    savePrivacyTools(storage, true);
    expect(loadPrivacyTools(storage)).toBe(true);
    savePrivacyTools(storage, false);
    expect(loadPrivacyTools(storage)).toBe(false);
    expect(Object.keys(storage.data)).toEqual([PRIVACY_TOOLS_STORAGE_KEY]);
  });

  it("treats any unexpected stored value as off", () => {
    expect(loadPrivacyTools(fakeStorage({ [PRIVACY_TOOLS_STORAGE_KEY]: "yes" }))).toBe(false);
  });

  it("never throws when the storage itself does", () => {
    expect(loadPrivacyTools(throwing)).toBe(false);
    expect(() => savePrivacyTools(throwing, true)).not.toThrow();
  });
});
