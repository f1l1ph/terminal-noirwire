import { test, expect } from "./support/test";
import { createAndFundWallet } from "./support/actions";
import { shot } from "./support/screenshot";

/**
 * A client-side-caught invalid order (below the market's minimum lot size,
 * so off the required increment) - distinct from `rejected-order.spec.ts`,
 * which covers a venue-level rejection the client cannot predict locally.
 * Second design review, section 5: captured as a missing state.
 */
test.describe("An invalid order (below the minimum lot size)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("is blocked locally, with a plain reason, before it ever reaches the venue", async ({
    page,
  }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    await page.getByLabel("Quantity (SOL)").fill("0.0001");
    await page.getByLabel("Quantity (SOL)").blur();
    await expect(page.getByText(/Use increments of/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Place test long", exact: true })).toBeDisabled();
    await shot(page, "01-invalid-order");
  });
});
