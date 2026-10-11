import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { dragMouse, sashBetween, center } from "./support/dockview";

/** Mirrors `LAYOUT_STORAGE_KEY` in src/lib/layout/dockviewLayout.ts - kept as a literal here rather than imported, since e2e specs drive the app as a black box. */
const LAYOUT_STORAGE_KEY = "noirwire-terminal-dockview-layout";

/**
 * A maximized group's siblings shrink to a zero-size grid cell but are not
 * removed from the DOM (dockview keeps "always"-rendered panels mounted),
 * so their tab can still report a non-empty bounding box - the box is just
 * the tab's own intrinsic size overflowing a zero-width ancestor, never
 * actually painted. `toBeVisible()` does not see that occlusion, so
 * "maximized" is asserted the same way `chart-resize.spec.ts` does: by the
 * Chart panel's own box growing to fill the workspace.
 */
async function chartPanelBox(page: Page) {
  const box = await page.getByRole("tabpanel", { name: "Chart" }).boundingBox();
  if (!box) throw new Error("expected the Chart panel to be visible");
  return box;
}

/**
 * The CRITICAL rule behind the dockview desktop layout: a panel's own React
 * state must never reset because the layout moved around it. A typed-but-
 * not-submitted quantity is the simplest outside observer of that - it
 * lives in `OrderEntry`'s own local state, so it only survives a drag, a
 * resize, a maximize/restore, and a tab switch elsewhere in the layout if
 * every panel was added with `renderer: "always"` and dockview really does
 * keep the panel mounted rather than remount it.
 */
test.describe("Layout changes never reset the order ticket", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a typed quantity survives dragging the ticket, a sash drag, maximize/restore, and a tab switch", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Chart" }).waitFor();

    const quantity = page.getByLabel("Quantity (SOL)");
    await quantity.fill("2.5");
    await expect(quantity).toHaveValue("2.5");

    // 1) Drag the Order ticket's tab onto the left edge of the Markets panel - it should dock to the workspace's left edge, becoming the new leftmost column.
    const ticketTab = page.getByRole("tab", { name: "Order ticket" });
    const marketsPanel = page.getByRole("tabpanel", { name: "Markets" });
    const ticketTabBoxBefore = await ticketTab.boundingBox();
    const marketsBoxBefore = await marketsPanel.boundingBox();
    if (!ticketTabBoxBefore || !marketsBoxBefore)
      throw new Error("expected both panels to be visible");

    await dragMouse(page, center(ticketTabBoxBefore), {
      x: marketsBoxBefore.x + 8,
      y: marketsBoxBefore.y + marketsBoxBefore.height / 2,
    });

    const ticketTabBoxAfter = await ticketTab.boundingBox();
    expect(ticketTabBoxAfter).toBeTruthy();
    // Far to the left of where it started, i.e. now at the workspace's own left edge.
    expect(ticketTabBoxAfter!.x).toBeLessThan(ticketTabBoxBefore.x - 400);
    await expect(quantity).toHaveValue("2.5");

    // 2) Drag the sash between the (now adjacent) ticket and Markets panels.
    const ticketPanel = page.getByRole("tabpanel", { name: "Order ticket" });
    const sash = await sashBetween(page, ticketPanel, marketsPanel, "vertical");
    await dragMouse(page, center(sash), {
      x: sash.x + sash.width / 2 + 40,
      y: sash.y + sash.height / 2,
    });
    await expect(quantity).toHaveValue("2.5");

    // 3) Maximize the Chart group (double-click its tab), then restore it (double-click again).
    const beforeMaximize = await chartPanelBox(page);
    const chartTab = page.getByRole("tab", { name: "Chart" });
    await chartTab.dblclick();
    const maximized = await chartPanelBox(page);
    expect(maximized.width).toBeGreaterThan(beforeMaximize.width + 300);
    await expect(quantity).toHaveValue("2.5");
    await chartTab.dblclick();
    const restored = await chartPanelBox(page);
    expect(restored.width).toBeLessThan(maximized.width - 300);
    await expect(page.getByRole("tab", { name: "Markets" })).toBeVisible();
    await expect(quantity).toHaveValue("2.5");

    // 4) Switch between Public view and Venue timing, the shared tab group.
    await page.getByRole("tab", { name: "Public view" }).click();
    await expect(page.getByRole("tabpanel", { name: "Public view" })).toBeVisible();
    await page.getByRole("tab", { name: "Venue timing" }).click();
    await expect(page.getByRole("tabpanel", { name: "Venue timing" })).toBeVisible();
    await expect(quantity).toHaveValue("2.5");

    // The chart and the account dock are the other two panels this rule protects - neither reloaded either.
    await expect(page.getByTestId("market-chart")).toBeVisible();
    await expect(page.getByText("Create a test wallet to see your account.")).toBeVisible();
  });
});

test.describe("The layout persists and recovers", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("survives a page reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Chart" }).waitFor();

    // Rearrange (drag the Order ticket to the workspace's left edge) rather
    // than probing with maximize: dockview's own serialized layout is the
    // grid of groups and their sizes, not which group is momentarily
    // maximized, so that is the real thing a reload must bring back.
    const ticketTab = page.getByRole("tab", { name: "Order ticket" });
    const marketsPanel = page.getByRole("tabpanel", { name: "Markets" });
    const ticketTabBoxBefore = await ticketTab.boundingBox();
    const marketsBoxBefore = await marketsPanel.boundingBox();
    if (!ticketTabBoxBefore || !marketsBoxBefore)
      throw new Error("expected both panels to be visible");
    await dragMouse(page, center(ticketTabBoxBefore), {
      x: marketsBoxBefore.x + 8,
      y: marketsBoxBefore.y + marketsBoxBefore.height / 2,
    });
    const ticketTabBoxAfter = await ticketTab.boundingBox();
    expect(ticketTabBoxAfter).toBeTruthy();
    expect(ticketTabBoxAfter!.x).toBeLessThan(ticketTabBoxBefore.x - 400);

    // The save is debounced - give it a moment to land before reloading.
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_STORAGE_KEY))
      .not.toBeNull();

    await page.reload();
    await page.getByRole("tab", { name: "Chart" }).waitFor();
    const ticketTabBoxAfterReload = await page
      .getByRole("tab", { name: "Order ticket" })
      .boundingBox();
    expect(ticketTabBoxAfterReload).toBeTruthy();
    expect(ticketTabBoxAfterReload!.x).toBeLessThan(ticketTabBoxBefore.x - 400);
  });

  test("Reset layout brings back the default arrangement", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Chart" }).waitFor();

    const beforeMaximize = await chartPanelBox(page);
    const chartTab = page.getByRole("tab", { name: "Chart" });
    await chartTab.dblclick();
    const maximized = await chartPanelBox(page);
    expect(maximized.width).toBeGreaterThan(beforeMaximize.width + 300);

    await page.getByRole("button", { name: "Reset layout" }).click();
    await expect(page.getByRole("tab", { name: "Markets" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Chart" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Order ticket" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Account" })).toBeVisible();
    const restored = await chartPanelBox(page);
    expect(restored.width).toBeLessThan(maximized.width - 300);

    // The save is debounced - poll rather than check immediately.
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_STORAGE_KEY))
      .not.toBeNull();
  });

  test("a corrupt saved layout falls back to the default without an error on the page", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.addInitScript(
      ([key]) => {
        window.localStorage.setItem(key, "{ not even json");
      },
      [LAYOUT_STORAGE_KEY],
    );
    await page.goto("/");
    await page.getByRole("tab", { name: "Chart" }).waitFor();

    await expect(page.getByText("Something went wrong.")).not.toBeVisible();
    await expect(page.getByRole("tab", { name: "Chart" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Order ticket" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
