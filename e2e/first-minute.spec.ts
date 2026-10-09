import { test, expect } from "./support/test";
import { shot } from "./support/screenshot";

test.describe("First minute: wallet, funds, a filled market long", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("creates a wallet, gets test funds, and places a market long that fills", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Create test wallet" })).toBeVisible();
    await shot(page, "01-arrival");

    await page.getByRole("button", { name: "Create test wallet" }).click();
    await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();
    await shot(page, "02-wallet-created");

    await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
    await expect(page.getByText("Available: 5,000.00 nUSD")).toBeVisible();
    await shot(page, "03-funded");

    await page.getByLabel("Quantity (SOL)").fill("1");
    await expect(page.getByText("Initial margin (est.)")).toBeVisible();

    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    await expect(dialog).toBeVisible();
    await shot(page, "04-confirm-first-order");
    await dialog.getByRole("button", { name: "Place test long", exact: true }).click();

    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot(page, "05-filled-rail");

    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("long", { exact: true })).toBeVisible();
    await shot(page, "06-positions");

    // A second order in the same session is one click: no confirm dialog.
    await page.getByLabel("Quantity (SOL)").fill("0.5");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "Confirm order" })).toHaveCount(0);
  });
});
