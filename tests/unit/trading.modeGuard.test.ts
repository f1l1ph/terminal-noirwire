import { describe, expect, it } from "vitest";
import { mainnetRefusals, unsignedDevModeRefusal } from "@/lib/trading/modeGuard";

const PINS = { programId: "P", rollupRpcUrl: "R", rollupWsUrl: "W" };
const mainnetWith = (solanaRpcUrl: string | undefined) =>
  mainnetRefusals(
    {
      tradingMode: "rollup",
      allowUnsignedDev: undefined,
      networkLabel: "MAINNET",
      programIdOverride: undefined,
      rollupRpcUrlOverride: undefined,
      rollupWsUrlOverride: undefined,
      solanaRpcUrl,
    },
    PINS,
  );

describe("mainnetRefusals Solana RPC url", () => {
  it("accepts a plain https origin", () => {
    expect(mainnetWith("https://rpc.example.com")).toEqual([]);
  });

  it.each([
    "https://rpc.example.com?api-key=abc",
    "https://rpc.example.com/path?api-key=abc",
    "https://rpc.example.com/path#frag",
    "https://user:pass@rpc.example.com",
    "https://rpc.example.com/",
    "http://rpc.example.com",
  ])("refuses %s", (url) => {
    expect(mainnetWith(url)).toHaveLength(1);
  });
});

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
