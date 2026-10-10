import type { Page } from "@playwright/test";
import { expect } from "./test";

export async function createWallet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create test wallet" }).click();
  await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible();
}

export async function fundWallet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Get 5,000 test nUSD" }).click();
  // Third design review, must-fix 2: once this wallet's one-time grant is
  // used, the account details say so instead of a plain "Available:" line -
  // true the moment this grant lands, same session or not.
  await expect(page.getByText("Grant used · 5,000.00 nUSD available")).toBeVisible();
}

export async function createAndFundWallet(page: Page): Promise<void> {
  await createWallet(page);
  await fundWallet(page);
}

/** Submits the currently valid order form, confirming the one-time session dialog if it appears. */
export async function submitOrder(page: Page, submitLabel: string): Promise<void> {
  await page.getByRole("button", { name: submitLabel, exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm order" });
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: submitLabel, exact: true }).click();
  }
}
