import path from "node:path";
import type { Page } from "@playwright/test";

const DIR = path.join(process.cwd(), "e2e", "screenshots");

export async function shot(page: Page, name: string): Promise<void> {
  const size = page.viewportSize();
  const suffix = size ? `${size.width}x${size.height}` : "unknown";
  await page.screenshot({ path: path.join(DIR, `${name}-${suffix}.png`) });
}
