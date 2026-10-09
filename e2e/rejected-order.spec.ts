import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

test.describe("A rejected order", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("reduce-only in the wrong direction is rejected by the venue, with a plain reason, never a fill", async ({
    page,
  }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    // Open a long first: the local estimate cannot predict a reduce-only
    // mismatch (the venue decides that from position direction), so this
    // is a genuine venue rejection, not a client-side pre-block.
    await page.getByLabel("Quantity (SOL)").fill("1");
    await submitOrder(page, "Place test long");
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 15_000 });
    // Wait for the position poll to land: only then does the venue (and this
    // form) know there is something to reduce.
    await expect(page.getByLabel(/Reduce only/)).toBeEnabled({ timeout: 15_000 });

    await page.getByLabel("Quantity (SOL)").fill("0.5");
    await page.getByLabel(/Reduce only/).check();
    await submitOrder(page, "Place test long");

    await expect(page.getByText("Rejected", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/reduce-only/).first()).toBeVisible();
    await shot(page, "01-rejected");
  });
});
