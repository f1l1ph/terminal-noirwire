import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { center, dragMouse, sashBetween } from "./support/dockview";

/**
 * lightweight-charts draws its plot in several canvases side by side inside
 * `[data-testid="market-chart"]` (the main pane, the price-axis strip, the
 * time-axis strip, each doubled for the crosshair layer) - comparing a
 * single canvas's width to the container's is not the right check, since
 * the price-axis strip alone is only a few dozen pixels wide. The bounding
 * box that encloses every canvas is what "the chart fills its panel" means,
 * and that is what must track the container after a layout change.
 */
const TOLERANCE_PX = 4;

async function settle(page: Page): Promise<void> {
  // ResizeObserver callbacks run before the next paint, not synchronously
  // with the DOM change that triggered them - two animation frames is the
  // standard, reliable way to wait for one to have definitely run.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

interface ChartFit {
  containerWidth: number;
  containerHeight: number;
  filledWidth: number;
  filledHeight: number;
}

async function chartFit(page: Page): Promise<ChartFit> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="market-chart"]') as HTMLElement;
    const canvases = Array.from(container.querySelectorAll("canvas"));
    const rect = container.getBoundingClientRect();
    let right = 0;
    let bottom = 0;
    for (const canvas of canvases) {
      const canvasRect = canvas.getBoundingClientRect();
      right = Math.max(right, canvasRect.right - rect.left);
      bottom = Math.max(bottom, canvasRect.bottom - rect.top);
    }
    return {
      containerWidth: rect.width,
      containerHeight: rect.height,
      filledWidth: right,
      filledHeight: bottom,
    };
  });
}

/** Waits for the chart to settle, then asserts its canvases fill the container within a few pixels - never short of it, never past it. */
async function expectChartFillsContainer(page: Page): Promise<ChartFit> {
  await settle(page);
  const fit = await chartFit(page);
  expect(Math.abs(fit.filledWidth - fit.containerWidth)).toBeLessThanOrEqual(TOLERANCE_PX);
  expect(Math.abs(fit.filledHeight - fit.containerHeight)).toBeLessThanOrEqual(TOLERANCE_PX);
  return fit;
}

test.describe("The chart canvas always fills its panel", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("after a column sash drag, a row sash drag, shrinking both back, and maximize/restore", async ({
    page,
  }) => {
    await page.goto("/");
    // The desktop workspace loads dockview through a client-only dynamic
    // import; waiting for market context text alone can race its chunk.
    await page.getByTestId("market-chart").waitFor();

    const atDefault = await expectChartFillsContainer(page);

    const marketsPanel = page.getByRole("tabpanel", { name: "Markets" });
    const chartPanel = page.getByRole("tabpanel", { name: "Chart" });
    const tapePanel = page.getByRole("tabpanel", { name: "Public tape" });

    // 1) Drag the Markets|Chart column sash left: Markets shrinks, the chart widens.
    const columnSash = await sashBetween(page, marketsPanel, chartPanel, "vertical");
    await dragMouse(page, center(columnSash), {
      x: columnSash.x + columnSash.width / 2 - 60,
      y: columnSash.y + columnSash.height / 2,
    });
    const afterColumnWiden = await expectChartFillsContainer(page);
    expect(afterColumnWiden.containerWidth).toBeGreaterThan(atDefault.containerWidth + 20);

    // 2) Drag the Chart|Public tape row sash down: the chart grows taller.
    const rowSash = await sashBetween(page, chartPanel, tapePanel, "horizontal");
    await dragMouse(page, center(rowSash), {
      x: rowSash.x + rowSash.width / 2,
      y: rowSash.y + rowSash.height / 2 + 60,
    });
    const afterRowGrow = await expectChartFillsContainer(page);
    expect(afterRowGrow.containerHeight).toBeGreaterThan(afterColumnWiden.containerHeight + 20);

    // 3) Now shrink both back: the canvas must shrink to match, never overflow its (now smaller) container.
    const columnSashAgain = await sashBetween(page, marketsPanel, chartPanel, "vertical");
    await dragMouse(page, center(columnSashAgain), {
      x: columnSashAgain.x + columnSashAgain.width / 2 + 150,
      y: columnSashAgain.y + columnSashAgain.height / 2,
    });
    const rowSashAgain = await sashBetween(page, chartPanel, tapePanel, "horizontal");
    await dragMouse(page, center(rowSashAgain), {
      x: rowSashAgain.x + rowSashAgain.width / 2,
      y: rowSashAgain.y + rowSashAgain.height / 2 - 150,
    });
    const afterShrink = await expectChartFillsContainer(page);
    expect(afterShrink.containerWidth).toBeLessThan(afterColumnWiden.containerWidth);
    expect(afterShrink.containerHeight).toBeLessThan(afterRowGrow.containerHeight);

    // 4) Maximize the Chart group: it fills nearly the whole workspace.
    const chartTab = page.getByRole("tab", { name: "Chart" });
    await chartTab.dblclick();
    const maximized = await expectChartFillsContainer(page);
    expect(maximized.containerWidth).toBeGreaterThan(afterShrink.containerWidth + 100);

    // 5) Restore: back to a Chart-column-sized container, still filled exactly.
    await chartTab.dblclick();
    const restored = await expectChartFillsContainer(page);
    expect(restored.containerWidth).toBeLessThan(maximized.containerWidth - 100);
  });
});
