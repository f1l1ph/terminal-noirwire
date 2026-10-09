import { test, expect } from "@playwright/test";

/**
 * Opt-in only (`make e2e-rollup`, never part of `make e2e`/`make e2e-live`
 * or CI): the first-minute flow signed in this browser against a REAL
 * local rollup plus sim-noirwire running in `VENUE=rollup` mode. Needs the
 * local network on ports 8899/7799/6699 and the service already running -
 * see README, "Running against the real rollup." This never starts or
 * stops that network itself (another engineer may be using those ports).
 */
test.describe("First minute, signed in the browser, against the real rollup", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("creates a wallet, opens and funds the real account, and places a market long that fills", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible();

    await page.getByRole("button", { name: "Create test wallet" }).click();
    await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();

    // Opens the real account and deposits 5,000 nUSD of collateral in one
    // on-chain transaction (sim-noirwire's `/v1/fund/prepare` + `/v1/fund/submit`),
    // signed locally with the owner key derived from this browser wallet.
    await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
    await expect(page.getByText("Available: 5,000.00 nUSD")).toBeVisible({ timeout: 60_000 });

    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }

    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^(Filled|Resting|Partially filled)$/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 10_000,
    });
  });
});
