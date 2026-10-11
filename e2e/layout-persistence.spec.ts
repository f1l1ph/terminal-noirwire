import { test, expect } from "./support/test";

/**
 * The CRITICAL rule behind the movable/resizable/collapsible desktop
 * layout: none of it may ever unmount the order ticket. A typed-but-not-
 * submitted quantity is the simplest outside observer of that - it lives in
 * `OrderEntry`'s own local state, so it only survives a column swap, a
 * splitter drag and another panel's collapse if `OrderEntry` itself stayed
 * mounted throughout, never re-created with a fresh initial state.
 */
test.describe("Layout changes never reset the order ticket", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a typed quantity survives a column swap, a resize, and a collapse of another panel", async ({
    page,
  }) => {
    await page.goto("/");

    const quantity = page.getByLabel("Quantity (SOL)");
    await quantity.fill("2.5");
    await expect(quantity).toHaveValue("2.5");

    // 1) Swap the order ticket and the markets column by dragging one grip onto the other panel.
    const ticketGrip = page.getByRole("button", { name: "Move Order ticket panel" });
    const marketsNav = page.getByRole("navigation", { name: "Markets" });
    const ticketBoxBefore = await ticketGrip.boundingBox();
    const marketsBox = await marketsNav.boundingBox();
    if (!ticketBoxBefore || !marketsBox) throw new Error("expected both panels to be visible");

    await page.mouse.move(
      ticketBoxBefore.x + ticketBoxBefore.width / 2,
      ticketBoxBefore.y + ticketBoxBefore.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      marketsBox.x + marketsBox.width / 2,
      marketsBox.y + marketsBox.height / 2,
      {
        steps: 12,
      },
    );
    await page.mouse.up();

    // The ticket panel's grip should now sit roughly where Markets used to be (far left), not at the far right.
    const ticketBoxAfter = await ticketGrip.boundingBox();
    expect(ticketBoxAfter).toBeTruthy();
    expect(ticketBoxAfter!.x).toBeLessThan(ticketBoxBefore.x - 400);
    await expect(quantity).toHaveValue("2.5");

    // 2) Drag a column splitter.
    const splitter = page.getByRole("separator").first();
    const splitterBox = await splitter.boundingBox();
    if (!splitterBox) throw new Error("expected a splitter to be visible");
    await page.mouse.move(
      splitterBox.x + splitterBox.width / 2,
      splitterBox.y + splitterBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      splitterBox.x + splitterBox.width / 2 + 40,
      splitterBox.y + splitterBox.height / 2,
      {
        steps: 8,
      },
    );
    await page.mouse.up();
    await expect(quantity).toHaveValue("2.5");

    // 3) Collapse another panel (Evidence).
    await page.getByRole("button", { name: "Collapse Evidence panel" }).click();
    await expect(page.getByRole("button", { name: "Expand Evidence panel" })).toBeVisible();
    await expect(quantity).toHaveValue("2.5");

    // The chart and the account dock are the other two panels this rule protects - neither reloaded either.
    await expect(page.getByTestId("market-chart")).toBeVisible();
    await expect(page.getByText("Create a test wallet to see your account.")).toBeVisible();
  });
});
