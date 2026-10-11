import type { Locator, Page } from "@playwright/test";

/**
 * dockview gives no sash its own accessible name, so a specific splitter
 * (as opposed to "the first separator on the page") is found by where it
 * sits: the one sash whose midpoint falls in the gap between two known,
 * already-adjacent panels. `tolerancePx` absorbs the sash's own width and
 * any panel padding.
 */
export async function sashBetween(
  page: Page,
  before: Locator,
  after: Locator,
  orientation: "vertical" | "horizontal",
  tolerancePx = 24,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const beforeBox = await before.boundingBox();
  const afterBox = await after.boundingBox();
  if (!beforeBox || !afterBox) throw new Error("expected both panels to be visible");
  const selector =
    orientation === "vertical"
      ? ".dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash"
      : ".dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash";
  const sashes = page.locator(selector);
  const count = await sashes.count();
  for (let index = 0; index < count; index += 1) {
    const box = await sashes.nth(index).boundingBox();
    if (!box) continue;
    if (orientation === "vertical") {
      const mid = box.x + box.width / 2;
      if (mid >= beforeBox.x + beforeBox.width - tolerancePx && mid <= afterBox.x + tolerancePx) {
        return box;
      }
    } else {
      const mid = box.y + box.height / 2;
      if (mid >= beforeBox.y + beforeBox.height - tolerancePx && mid <= afterBox.y + tolerancePx) {
        return box;
      }
    }
  }
  throw new Error("no sash found between the given panels");
}

export async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

export function center(box: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
