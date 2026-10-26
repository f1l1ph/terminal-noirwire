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

    await page.getByLabel("Order type").selectOption("limit");
    const limitPrice = page.getByLabel(/Limit price/);
    await expect(limitPrice).not.toHaveValue("");
    const passivePrice = Number(await limitPrice.inputValue());
    const restingPrice = (Math.round((passivePrice * 0.95) / 0.1) * 0.1).toFixed(2);

    await limitPrice.fill(restingPrice);
    await page.getByLabel("Amount (nUSD)").fill("200");

    await submitOrder(page, "Place test long");

    await expect(page.getByText("Resting", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-resting");

    await page.getByRole("tab", { name: "Open orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("SOL-PERP")).toBeVisible();
    await shot(page, "02-open-orders");

    await page.getByRole("button", { name: "Cancel all SOL-PERP orders" }).click();
    await expect(
      page.getByRole("tabpanel").getByText("No open orders", { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "03-cancelled");
  });
});
