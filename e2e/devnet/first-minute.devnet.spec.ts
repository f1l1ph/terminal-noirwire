import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  loadPersistedWallet,
  savePersistedWallet,
  WALLET_STORAGE_KEY,
} from "../support/devnetWallet";

/**
 * Opt-in only (`make e2e-devnet`, never part of `make e2e`/`make e2e-live`/
 * `make e2e-rollup` or CI): the first-minute flow signed in this browser
 * against the real order book live on Solana devnet, through a sim-noirwire
 * already running in `VENUE=rollup` mode pointed at devnet (another
 * engineer's process - this never starts, stops or reconfigures it).
 *
 * Reuses the wallet persisted in `e2e/.devnet-wallet.json` across every run:
 * devnet seats are scarce (100 new accounts/day, one funding grant per
 * address), so a wallet is created here at most once, ever. A run against
 * an already-funded wallet skips the grant and still passes - the balance
 * check below accepts either a fresh grant landing or a balance already
 * there from a previous run.
 */
const SCREENSHOT_DIR = path.join(process.cwd(), "e2e", "screenshots");

async function shot(page: Page, name: string): Promise<void> {
  const size = page.viewportSize();
  const suffix = size ? `${size.width}x${size.height}` : "unknown";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `devnet-${name}-${suffix}.png`) });
}

/** Seeds this page's localStorage with the persisted wallet before any script runs, or leaves it empty so the UI creates (and this then persists) a new one. */
async function primeWallet(page: Page): Promise<{ reused: boolean }> {
  const persisted = loadPersistedWallet();
  if (persisted) {
    await page.addInitScript(([key, secretHex]) => window.localStorage.setItem(key, secretHex), [
      WALLET_STORAGE_KEY,
      persisted.secretHex,
    ] as const);
    return { reused: true };
  }
  return { reused: false };
}

const SPOT_SELL_SIZE = "0.20";

/** The spot rows of the open Balances tab: the base token and the spot nUSD (not the collateral row, which is labelled as such). */
async function spotBalances(page: Page): Promise<{ base: number; quote: number }> {
  const text = await page.getByRole("tabpanel").innerText();
  const amountAfter = (label: RegExp) => Number(text.match(label)?.[1].replace(/,/g, "") ?? NaN);
  return {
    base: amountAfter(/nSOL\s+([\d,.]+)/),
    quote: amountAfter(/(?:^|\n)nUSD\s+([\d,.]+) nUSD/),
  };
}

async function ensureWalletPersisted(page: Page, alreadyReused: boolean): Promise<void> {
  if (alreadyReused) return;
  // A fresh wallet: reveal and persist its secret so every later run (and
  // every other manual check this pass) reuses this exact address instead
  // of spending another of devnet's limited new-account seats.
  await page.getByRole("button", { name: /^[A-Za-z0-9]+…[A-Za-z0-9]+$/ }).click();
  await page.getByRole("button", { name: "Save recovery details" }).click();
  const secretText = await page.locator("p.break-all").innerText();
  savePersistedWallet(secretText.trim());
  await page.keyboard.press("Escape").catch(() => {});
  // Close the dropdown by clicking elsewhere.
  await page.locator("body").click({ position: { x: 10, y: 10 } });
}

test.describe("First minute, signed in the browser, against real Solana devnet", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("creates or reuses a wallet, funds it if needed, trades, transfers, and survives a reload", async ({
    page,
  }) => {
    const { reused } = await primeWallet(page);
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "01-arrival");

    if (!reused) {
      await page.getByRole("button", { name: "Create test wallet" }).click();
      await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible({
        timeout: 15_000,
      });
      await ensureWalletPersisted(page, false);
    }
    await shot(page, "02-signed-in");

    // Funding: a fresh grant, or this wallet already has a balance from an
    // earlier run - either way, a real nonzero balance must show up.
    const fundButton = page.getByRole("button", { name: "Get 5,000 test nUSD" });
    if (await fundButton.isVisible().catch(() => false)) {
      await fundButton.click();
    }
    await expect(
      page.getByText(/(Available: [1-9][0-9,]*\.\d\d nUSD|Grant used · [1-9][0-9,]*\.\d\d nUSD)/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "03-funded");

    // Market long on NSOL-PERP, filled against the house maker.
    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }
    await expect(
      page.getByText(/^(Filled|Resting|Partially filled|Checking with the venue)$/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "04-market-long");

    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "05-fills-and-position");

    // A resting limit order near the live mark, on the passive (buy) side -
    // close enough to look like a real instruction, not a test fixture, but
    // outside the spread so it rests rather than crossing at once (third
    // design review, must-fix 6). The market order's own "max buy price"
    // (mark plus 1%) is the most reliable read of "the current mark" on
    // screen; 3% below the mark, tick-aligned, leaves headroom against the
    // thin test venue's own bots while still reading as plausible.
    const maxBuyPrice = await page.getByLabel("Max buy price (nUSD)").inputValue();
    const mark = Number(maxBuyPrice) / 1.01;
    const restingPrice = (Math.round((mark * 0.97) / 0.1) * 0.1).toFixed(2);

    await page.getByRole("button", { name: "limit", exact: true }).click();
    await page.getByLabel("Quantity (SOL)").fill("0.1");
    await page.getByLabel(/Limit price/).fill(restingPrice);
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const limitDialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await limitDialog.isVisible().catch(() => false)) {
      await limitDialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }
    await expect(page.getByText("Resting", { exact: true })).toBeVisible({ timeout: 60_000 });
    // The dock auto-shows Open orders while this session's own order rests
    // (section 3, item 2); the full row - id, price, remaining size, its
    // own cancel - is what this screenshot is for.
    await expect(page.getByRole("tab", { name: "Open orders" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tabpanel").getByText(/Cancel #/)).toBeVisible();
    await shot(page, "06-resting-open-orders-row");

    // Cancelled from the dock's own row, by id, matching the review's ask.
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: /Cancel #/ })
      .click();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 60_000 });
    // The dock auto-returns to whatever tab was open before the order
    // started resting (section 3, item 2) - click back to Open orders so
    // this shot holds both the rail's cancelled receipt and the now-empty
    // dock row together, per the review's own recording script.
    await page.getByRole("tab", { name: "Open orders" }).click();
    await expect(page.getByRole("tabpanel").getByText("No open orders.")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "07-cancelled-by-id");

    // Move funds to spot, then a spot buy on NSOL-NUSD.
    await page.getByRole("button", { name: "NSOL-NUSD" }).click();
    await expect(page.getByText("Trade NSOL-NUSD")).toBeVisible({ timeout: 15_000 });
    const moveButton = page.getByRole("button", { name: "Move funds to spot" });
    if (await moveButton.isVisible().catch(() => false)) {
      await moveButton.click();
      await page.getByLabel("Transfer amount (nUSD)").fill("500");
      await page.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByText(/(Available: [1-9]|Grant used · [1-9].* available)/)).toBeVisible(
        { timeout: 60_000 },
      );
    }
    await page.getByLabel("Quantity (nSOL)").fill("1");
    await page.getByRole("button", { name: "Place test buy", exact: true }).first().click();
    await expect(
      page.getByText(/^(Filled|Resting|Partially filled|Checking with the venue)$/),
    ).toBeVisible({ timeout: 90_000 });
    await shot(page, "08-spot-filled");

    // A small spot sell: spends the base token just bought, credits nUSD.
    await page.getByRole("tab", { name: "Balances" }).click();
    const before = await spotBalances(page);
    await page.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(page.getByText(/^Available: [0-9.]+ nSOL$/)).toBeVisible();
    await page.getByLabel("Quantity (nSOL)").fill(SPOT_SELL_SIZE);
    await page.getByRole("button", { name: "Place test sell", exact: true }).first().click();
    await expect(page.getByText(/^Sell 0\.200 nSOL · Market/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await spotBalances(page)).base, { timeout: 30_000 })
      .toBeCloseTo(before.base - Number(SPOT_SELL_SIZE), 6);
    expect((await spotBalances(page)).quote).toBeGreaterThan(before.quote);
    await shot(page, "08b-spot-sold");

    // The unsigned account check: trader view and book both report no data.
    await page.getByRole("button", { name: "Check unsigned accounts" }).click();
    await expect(page.getByText("Trader view · no data returned")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/book · no data returned/)).toBeVisible();
    // Enlarged, readable-at-video-size evidence panel (third design review,
    // must-fix 7), not the narrow inline summary.
    await page.getByRole("button", { name: "Enlarge evidence" }).click();
    const evidenceDialog = page.getByRole("dialog", { name: "Privacy evidence" });
    await expect(evidenceDialog).toBeVisible();
    await expect(evidenceDialog.getByText(/Unsigned devnet rollup RPC/)).toBeVisible();
    await shot(page, "09-privacy-evidence-enlarged");

    // Reload: account, positions and own-fill marks all come back.
    await page.reload();
    await expect(page.getByText(/(Available:|Grant used ·)/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.getByRole("tabpanel").getByText("NSOL-PERP")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "10-after-reload");
  });
});

test.describe("Phone views against real Solana devnet", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("funded and filled states at 390 wide", async ({ page }) => {
    const { reused } = await primeWallet(page);
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible({ timeout: 30_000 });

    if (!reused) {
      await page.getByRole("button", { name: "Create test wallet" }).click();
      await expect(page.getByRole("button", { name: "Get 5,000 test nUSD" })).toBeVisible({
        timeout: 15_000,
      });
    }
    const fundButton = page.getByRole("button", { name: "Get 5,000 test nUSD" });
    if (await fundButton.isVisible().catch(() => false)) {
      await fundButton.click();
    }
    await expect(
      page.getByText(/(Available: [1-9][0-9,]*\.\d\d nUSD|Grant used · [1-9][0-9,]*\.\d\d nUSD)/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "phone-funded");

    await page.getByLabel("Quantity (SOL)").fill("1");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    }
    await expect(
      page.getByText(/^(Filled|Resting|Partially filled|Checking with the venue)$/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "phone-filled");
  });
});
