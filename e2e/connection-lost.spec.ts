import { test, expect } from "./support/test";
import { fakeSim } from "./support/fakeSim";
import { shot } from "./support/screenshot";

test.describe("Connection lost and recovered", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows connection lost when the stream drops, and recovers on its own", async ({ page }) => {
    await page.goto("/");
    const status = page.getByRole("status", { name: "Connected" });
    await expect(status).toBeVisible();
    await shot(page, "01-live");

    await fakeSim.disconnect();
    await expect(page.getByText("Connection lost, reconnecting", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "02-connection-lost");

    await fakeSim.reconnect();
    await expect(status).toBeVisible({ timeout: 20_000 });
    await shot(page, "03-recovered");
  });
});
