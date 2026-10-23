import { describe, expect, it } from "vitest";
import { unsignedDevModeRefusal } from "@/lib/trading/modeGuard";

describe("unsignedDevModeRefusal", () => {
  it("refuses dev mode in a production build", () => {
    expect(unsignedDevModeRefusal("dev", "production", undefined)).toMatch(/unsigned/);
  });

  it("allows dev mode outside production", () => {
    expect(unsignedDevModeRefusal("dev", "development", undefined)).toBeNull();
    expect(unsignedDevModeRefusal("dev", "test", undefined)).toBeNull();
  });

  it("allows rollup mode in a production build", () => {
    expect(unsignedDevModeRefusal("rollup", "production", undefined)).toBeNull();
  });

  it("allows dev mode in a production build only with the explicit opt-in", () => {
    expect(unsignedDevModeRefusal("dev", "production", "1")).toBeNull();
    expect(unsignedDevModeRefusal("dev", "production", "true")).not.toBeNull();
  });
});
