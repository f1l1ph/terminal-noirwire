import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

test.describe("A resting limit order, then cancelled", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a limit order placed away from the mark rests, then cancels its whole market", async ({
    page,
  }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    const maxBuyPrice = await page.getByLabel("Max buy price (nUSD)").inputValue();
    const mark = Number(maxBuyPrice) / 1.01;
    const restingPrice = (Math.round((mark * 0.95) / 0.1) * 0.1).toFixed(2);

    await page.getByRole("button", { name: "limit", exact: true }).click();
    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByLabel(/Limit price/).fill(restingPrice);

    await submitOrder(page, "Place test long");

    await expect(page.getByText("Resting", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-resting");

    await page.getByRole("tab", { name: "Open orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible();
    await shot(page, "02-open-orders");

    await page.getByRole("button", { name: "Cancel all NSOL-PERP orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("No open orders.")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "03-cancelled");
  });
});
