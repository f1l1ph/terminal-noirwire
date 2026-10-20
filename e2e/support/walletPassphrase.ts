import { expect, type Page } from "@playwright/test";

/**
 * A wallet lives in memory only until the trader sets a passphrase, so a
 * flow that reloads has to encrypt it first and unlock it after. Throwaway
 * test passphrase, long enough for the terminal's minimum.
 */
export const TEST_PASSPHRASE = "e2e-test-passphrase";

/** The header's wallet button: its short address, then any "Not saved"/"Locked" badge. */
function walletButton(page: Page) {
  return page.getByRole("button", { name: /^[A-Za-z0-9]+…[A-Za-z0-9]+/ });
}

export async function openWalletMenu(page: Page): Promise<void> {
  await walletButton(page).click();
}

export async function closeWalletMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

/** Encrypts the in-memory wallet under `TEST_PASSPHRASE` so it survives a reload. */
export async function keepWalletEncrypted(page: Page): Promise<void> {
  await openWalletMenu(page);
  await page.getByLabel("Passphrase for this device").fill(TEST_PASSPHRASE);
  await page.getByLabel("Repeat the passphrase").fill(TEST_PASSPHRASE);
  await page.getByRole("button", { name: "Encrypt and keep" }).click();
  await expect(page.getByText("Encrypted on this device.", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await closeWalletMenu(page);
}

/** Unlocks the encrypted wallet after a reload. */
export async function unlockWallet(page: Page): Promise<void> {
  await expect(walletButton(page)).toContainText("Locked", { timeout: 15_000 });
  await openWalletMenu(page);
  await page.getByLabel(/Enter its passphrase to trade/).fill(TEST_PASSPHRASE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(walletButton(page)).not.toContainText("Locked", { timeout: 15_000 });
  await closeWalletMenu(page);
}
