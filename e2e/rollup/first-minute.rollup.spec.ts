import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Opt-in only (`make e2e-rollup`, never part of `make e2e`/`make e2e-live`
 * or CI): the first-minute flow signed in this browser against a REAL
 * local rollup plus sim-noirwire running in `VENUE=rollup` mode. Needs the
 * local network on ports 8899/7799/6699 and the service already running -
 * see README, "Running against the real rollup." This never starts or
 * stops that network itself (it may be shared with someone testing the
 * program directly).
 */
const SCREENSHOT_DIR = path.join(process.cwd(), "e2e", "screenshots");

async function shot(page: Page, name: string): Promise<void> {
  const size = page.viewportSize();
  const suffix = size ? `${size.width}x${size.height}` : "unknown";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `rollup-${name}-${suffix}.png`) });
}

test.describe("First minute, signed in the browser, against the real rollup", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("creates a wallet, opens and funds the real account, trades, transfers, and survives a reload", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible();
    await shot(page, "01-arrival");

    await page.getByRole("button", { name: "Create test wallet" }).click();
    await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();

    // Opens the real account and deposits 5,000 nUSD of collateral in one
    // on-chain transaction (sim-noirwire's /v1/fund/prepare + /v1/fund/submit),
    // signed locally with the owner key derived from this browser wallet.
    await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
    await expect(page.getByText("Grant used · 5,000.00 nUSD available")).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, "02-funded");

    // Market long on NSOL-PERP, filled against the house maker.
    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^(Filled|Resting|Partially filled)$/)).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, "03-market-long-filled");

    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, "04-position");

    // A resting limit order away from the mark (within the program's 50%
    // outer band, RULES.md section 3 item 3 - far enough from the mark it
    // should never fill in a first-minute test, not so far it is refused).
    await page.getByRole("button", { name: "limit", exact: true }).click();
    await page.getByLabel("Quantity (SOL)").fill("0.2");
    await page.getByLabel(/Limit price/).fill("60.00");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    await expect(page.getByText("Resting", { exact: true })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "Open orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, "05-open-orders");

    // Per-order cancel: the real program has cancel_order, unlike dev mode.
    await page.getByRole("button", { name: /Cancel order/ }).click();
    await expect(page.getByRole("tabpanel").getByText("No open orders.")).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, "06-cancelled");

    // Move funds to spot, then a spot buy on NSOL-NUSD.
    await page.getByRole("button", { name: "NSOL-NUSD" }).click();
    await expect(page.getByText("Trade NSOL-NUSD")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Move funds to spot" }).click();
    await page.getByLabel("Transfer amount (nUSD)").fill("500");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Grant used · 500.00 nUSD available")).toBeVisible({
      timeout: 20_000,
    });

    // The spot market's unit is the base token's own symbol from the deployment description.
    await page.getByLabel(/^Quantity \(/).fill("1");
    await page.getByRole("button", { name: "Place test buy", exact: true }).first().click();
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 20_000 });
    await shot(page, "07-spot-filled");

    // The public view's second check: this trader's own on-chain view and
    // the market's book, read unsigned, both report no data returned.
    await page.getByRole("button", { name: "Check unsigned accounts" }).click();
    await expect(page.getByText("Trader view · no data returned")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/book · no data returned/)).toBeVisible();
    await shot(page, "08-privacy-check");

    // Own fills marked on the tape before reload.
    await expect(page.getByText("yours", { exact: true }).first()).toBeVisible();

    // Reload: account, positions and own-fill marks all come back.
    await page.reload();
    await expect(page.getByText(/Grant used ·/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("yours", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await shot(page, "09-after-reload");
  });
});

test.describe("Phone views against the real rollup", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("funded and filled states at 390 wide", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible();

    await page.getByRole("button", { name: "Create test wallet" }).click();
    await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();
    await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
    await expect(page.getByText("Grant used · 5,000.00 nUSD available")).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, "phone-funded");

    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }
    await expect(page.getByText(/^(Filled|Resting|Partially filled)$/)).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, "phone-filled");
  });
});
