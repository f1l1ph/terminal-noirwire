import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

test.describe("A resting limit order, then cancelled", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a limit order placed away from the mark rests, then cancels", async ({ page }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    await page.getByRole("button", { name: "limit", exact: true }).click();
    await page.getByLabel("Quantity (NSOL)").fill("1");
    await page.getByLabel(/Limit price/).fill("1.00");

    await submitOrder(page, "Place test long");

    await expect(page.getByText("Resting", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-resting");

    await page.getByRole("tab", { name: "Open orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible();
    await shot(page, "02-open-orders");

    await page.getByRole("button", { name: "Cancel order" }).click();
    await expect(page.getByRole("tabpanel").getByText("No open orders.")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "03-cancelled");
  });
});
