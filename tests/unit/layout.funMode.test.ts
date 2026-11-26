import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUN_MODE,
  FUN_MODE_STORAGE_KEY,
  loadFunMode,
  saveFunMode,
} from "@/lib/layout/funMode";
import { fakeStorage, throwingStorage } from "./support/choiceStorage";

describe("fun mode preference", () => {
  it("is off with both visuals chosen and the fuse tint by default", () => {
    expect(loadFunMode(fakeStorage())).toEqual({
      enabled: false,
      tint: true,
      tintStyle: "fuse",
      wizard: true,
    });
  });

  it("uses the default with no storage at all", () => {
    expect(loadFunMode(null)).toEqual(DEFAULT_FUN_MODE);
    expect(() => saveFunMode(null, DEFAULT_FUN_MODE)).not.toThrow();
  });

  it("remembers every setting under one key", () => {
    const storage = fakeStorage();
    const settings = { enabled: true, tint: false, tintStyle: "tripwire" as const, wizard: true };
    saveFunMode(storage, settings);
    expect(loadFunMode(storage)).toEqual(settings);
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

  it("keeps the other fields of a stored value without a tint style and gives it the fuse", () => {
    const stored = JSON.stringify({ enabled: true, tint: false, wizard: true });
    expect(loadFunMode(fakeStorage({ [FUN_MODE_STORAGE_KEY]: stored }))).toEqual({
      enabled: true,
      tint: false,
      tintStyle: "fuse",
      wizard: true,
    });
  });

  it("turns an unknown tint style into the fuse", () => {
    for (const tintStyle of ["lamp", 3, null]) {
      const stored = JSON.stringify({ enabled: true, tint: true, tintStyle, wizard: false });
      expect(loadFunMode(fakeStorage({ [FUN_MODE_STORAGE_KEY]: stored }))).toEqual({
        enabled: true,
        tint: true,
        tintStyle: "fuse",
        wizard: false,
      });
    }
  });

  it("never throws when the storage itself does", () => {
    expect(loadFunMode(throwingStorage)).toEqual(DEFAULT_FUN_MODE);
    expect(() => saveFunMode(throwingStorage, DEFAULT_FUN_MODE)).not.toThrow();
  });

  it("never throws when the settings cannot be serialised", () => {
    const unserialisable = {
      ...DEFAULT_FUN_MODE,
      toJSON: () => {
        throw new Error("cannot serialise");
      },
    };
    expect(() => saveFunMode(fakeStorage(), unserialisable)).not.toThrow();
    expect(() => saveFunMode(null, unserialisable)).not.toThrow();
  });
});
