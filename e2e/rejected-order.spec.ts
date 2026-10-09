import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

test.describe("A rejected order", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an order the trader cannot afford is rejected, with a plain reason, never a fill", async ({
    page,
  }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    // 40 NSOL at roughly 150 nUSD is far more than the 5,000 nUSD just funded.
    await page.getByLabel("Quantity (NSOL)").fill("40");

    await submitOrder(page, "Place test long");

    await expect(page.getByText("Rejected", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Insufficient test balance/).first()).toBeVisible();
    await shot(page, "01-rejected");

    await expect(page.getByText("Filled", { exact: true })).toHaveCount(0);
  });
});
