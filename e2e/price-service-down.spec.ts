import { test, expect } from "./support/test";
import { shot } from "./support/screenshot";

const KEPT_SETTINGS_NOTICE = /Price service unreachable\. Using the last market settings/;

test.describe("Price service down on page load", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a browser that saw the market settings before still opens the terminal, and says so", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("status", { name: "Connected" })).toBeVisible();
    await expect(page.getByText("Loading market settings.")).toHaveCount(0);

    await page.route(/\/v1\/(markets|deployment)(\?|$)/, (route) => route.abort());
    await page.reload();

    await expect(page.getByText(KEPT_SETTINGS_NOTICE)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Loading market settings.")).toHaveCount(0);
    await expect(page.getByText("Create a test wallet to see your account.")).toBeVisible();
    await shot(page, "01-price-service-down");
  });
});
