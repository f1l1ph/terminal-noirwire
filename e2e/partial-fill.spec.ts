import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

const PARTIAL_FILL_THRESHOLD = 3;

/**
 * A market order larger than the fake venue's test-only partial-fill
 * threshold (`e2e/fake-sim/server.mts`, `PARTIAL_FILL_TEST_THRESHOLD`)
 * fills part of itself now and rests the remainder - a real partiallyFilled
 * outcome, not a synthesized one. Second design review, section 5: captured
 * as a missing state.
 */
test.describe("A partial fill", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("fills part of the order now and rests the remainder, both visible", async ({ page }) => {
    await page.goto("/");
    await createAndFundWallet(page);

    await page.getByLabel("Amount (nUSD)").fill("750");
    await submitOrder(page, "Place test long");
    await expect(page.getByText("Partially filled", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const remainingLine = page.getByText(/Remaining [\d.]+ SOL of [\d.]+/);
    await expect(remainingLine).toBeVisible();
    const [, remaining, total] = (await remainingLine.innerText()).match(
      /Remaining ([\d.]+) SOL of ([\d.]+)/,
    )!;
    expect(Number(total)).toBeGreaterThan(PARTIAL_FILL_THRESHOLD);
    expect(Number(remaining)).toBeCloseTo(Number(total) - PARTIAL_FILL_THRESHOLD, 3);
    await shot(page, "01-partial-fill");
  });
});
