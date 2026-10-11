import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";

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

async function dragSeparator(page: Page, name: string, dx: number, dy: number): Promise<void> {
  const separator = page.getByRole("separator", { name });
  const box = await separator.boundingBox();
  if (!box) throw new Error(`expected the "${name}" separator to be visible`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe("The chart canvas always fills its panel", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("after collapsing Evidence, dragging a column splitter, and dragging the chart/tape splitter - growing and shrinking", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByText("NSOL-PERP").first().waitFor();

    const atDefault = await expectChartFillsContainer(page);

    // 1) Collapse Evidence: its width goes to the centre column, widening the chart.
    await page.getByRole("button", { name: "Collapse Evidence panel" }).click();
    const afterCollapse = await expectChartFillsContainer(page);
    expect(afterCollapse.containerWidth).toBeGreaterThan(atDefault.containerWidth + 100);

    // 2) Drag the Markets|Chart column splitter left: Markets shrinks, the chart widens further.
    await dragSeparator(page, "Resize Markets and Chart panels", -60, 0);
    const afterColumnWiden = await expectChartFillsContainer(page);
    expect(afterColumnWiden.containerWidth).toBeGreaterThan(afterCollapse.containerWidth + 20);

    // 3) Drag the Chart|Public tape splitter down: the chart grows taller.
    await dragSeparator(page, "Resize Chart and Public tape panels", 0, 60);
    const afterRowGrow = await expectChartFillsContainer(page);
    expect(afterRowGrow.containerHeight).toBeGreaterThan(afterColumnWiden.containerHeight + 20);

    // 4) Now shrink both back: the canvas must shrink to match, never overflow its (now smaller) container.
    await dragSeparator(page, "Resize Markets and Chart panels", 150, 0);
    await dragSeparator(page, "Resize Chart and Public tape panels", 0, -150);
    const afterShrink = await expectChartFillsContainer(page);
    expect(afterShrink.containerWidth).toBeLessThan(afterColumnWiden.containerWidth);
    expect(afterShrink.containerHeight).toBeLessThan(afterRowGrow.containerHeight);
    expect(afterShrink.filledWidth).toBeLessThanOrEqual(afterShrink.containerWidth + TOLERANCE_PX);
    expect(afterShrink.filledHeight).toBeLessThanOrEqual(
      afterShrink.containerHeight + TOLERANCE_PX,
    );
  });
});
