import { test, expect } from "./support/test";
import { shot } from "./support/screenshot";

test.describe("Public view carries no private rows", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an unsigned fetch shows the public shape only, including the tag field, and the account dock asks for a wallet first", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Create a test wallet to see your account.")).toBeVisible();

    await page.getByRole("button", { name: "Check public tape" }).click();
    // check() opens the detail panel itself; no second click needed.
    const toggle = page.getByRole("button", { name: /Checked at/ });
    await expect(toggle).toBeVisible();

    await expect(page.getByText(/Fields returned/)).toBeVisible();
    await expect(page.getByText(/takerTag/)).toBeVisible();

    const raw = page.locator("pre");
    await expect(raw).toBeVisible();
    const text = await raw.innerText();
    const parsed = JSON.parse(text) as { network: string; simulated: boolean; fills: unknown[] };
    expect(parsed.network).toBe("devnet");
    expect(parsed.simulated).toBe(true);
    expect(Array.isArray(parsed.fills)).toBe(true);
    expect(text).not.toContain("balances");
    expect(text).not.toContain("openOrders");
    expect(text).not.toContain("equity");
    await shot(page, "01-public-view-raw");
  });
});
