import { test, expect } from "./support/test";
import { shot } from "./support/screenshot";

test.describe("Phone layout at 390 wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no horizontal scroll, and the Trade / Market segmented control works", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Trade", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Market", exact: true })).toBeVisible();
    await shot(page, "01-trade-view");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await page.getByRole("button", { name: "Market", exact: true }).click();
    await expect(page.getByTestId("market-chart")).toBeVisible();
    await shot(page, "02-market-view");

    const scrollWidthMarket = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidthMarket).toBeLessThanOrEqual(clientWidth + 1);
  });
});
