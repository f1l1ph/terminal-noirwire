import { test, expect } from "@playwright/test";

/**
 * Opt-in only (`make e2e-live`, never part of `make e2e` or CI): the
 * first-minute flow against a REAL sim-noirwire instance, already running
 * at SIM_LIVE_URL (default http://localhost:4100). This proves the terminal
 * against real Jupiter-fed prices and the real `MemoryVenue` matching
 * engine, not the deterministic in-repo mock.
 */
test.describe("First minute against a real sim-noirwire instance", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("creates a wallet, gets test funds, and places a market long that fills", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible();

    await page.getByRole("button", { name: "Create test wallet" }).click();
    await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();

    await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
    await expect(page.getByText("Grant used · 5,000.00 nUSD available")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }

    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("long", { exact: true })).toBeVisible();
  });
});
