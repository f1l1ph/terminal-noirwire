import { test, expect } from "./support/test";
import { shot } from "./support/screenshot";

test.describe("Public view carries no private rows", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an unsigned fetch shows the public shape only, and the account dock asks for a wallet first", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Create a test wallet to see your account.")).toBeVisible();

    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByText(/Checked at/)).toBeVisible();

    await page.getByRole("button", { name: "View raw response" }).click();
    const raw = page.locator("pre");
    await expect(raw).toBeVisible();
    const text = await raw.innerText();
    const parsed = JSON.parse(text) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(text).not.toContain("balances");
    expect(text).not.toContain("openOrders");
    expect(text).not.toContain("ownFills");
    await shot(page, "01-public-view-raw");
  });
});
