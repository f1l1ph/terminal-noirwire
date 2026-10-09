import { test, expect } from "./support/test";
import { fakeSim } from "./support/fakeSim";
import { shot } from "./support/screenshot";

test.describe("Connection lost and recovered", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows connection lost when the stream drops, and recovers on its own", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await shot(page, "01-live");

    await fakeSim.disconnect();
    await expect(page.getByText("Connection lost", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "02-connection-lost");

    await fakeSim.reconnect();
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
    await shot(page, "03-recovered");
  });
});
