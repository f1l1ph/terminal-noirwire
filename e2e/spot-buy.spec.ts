import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

test.describe("A spot buy", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a filled spot buy updates the base asset balance", async ({ page }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    await page.getByRole("button", { name: "NSOL-NUSD" }).click();
    await expect(page.getByText("Trade NSOL-NUSD")).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy", exact: true })).toBeVisible();

    await page.getByLabel("Quantity (SOL)").fill("1");
    await submitOrder(page, "Place test buy");

    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Balances" }).click();
    await expect(page.getByRole("tabpanel").getByText("SOL")).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-spot-filled");
  });
});
