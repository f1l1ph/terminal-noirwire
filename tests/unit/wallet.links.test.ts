import { describe, expect, it } from "vitest";
import { isMobileBrowser, phantomBrowseUrl, solflareBrowseUrl } from "@/lib/wallet/walletLinks";

describe("the mobile browser check", () => {
  it("trusts userAgentData when the browser has it", () => {
    expect(isMobileBrowser({ userAgentData: { mobile: true }, userAgent: "Macintosh" })).toBe(true);
    expect(isMobileBrowser({ userAgentData: { mobile: false }, userAgent: "iPhone" })).toBe(false);
  });

  it("reads the user agent otherwise", () => {
    expect(isMobileBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" })).toBe(true);
    expect(isMobileBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" })).toBe(true);
    expect(isMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(
      false,
    );
    expect(isMobileBrowser({})).toBe(false);
  });
});

describe("the wallet app deep links", () => {
  const page = "https://app.example.com/trade?market=SOL-PERP#chart";
  const origin = "https://app.example.com";

  it("opens the page in Phantom with the origin as ref", () => {
    expect(phantomBrowseUrl(page, origin)).toBe(
      "https://phantom.app/ul/browse/https%3A%2F%2Fapp.example.com%2Ftrade%3Fmarket%3DSOL-PERP%23chart?ref=https%3A%2F%2Fapp.example.com",
    );
  });

  it("opens the page in Solflare with the origin as ref", () => {
    expect(solflareBrowseUrl(page, origin)).toBe(
      "https://solflare.com/ul/v1/browse/https%3A%2F%2Fapp.example.com%2Ftrade%3Fmarket%3DSOL-PERP%23chart?ref=https%3A%2F%2Fapp.example.com",
    );
  });
});
