import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { createAndFundWallet, submitOrder } from "./support/actions";
import { shot } from "./support/screenshot";

interface SentOrder {
  market: string;
  side: string;
  type: string;
  size: string;
  reduceOnly?: boolean;
}

/** Records every order the page posts to the fake sim, as the sim received it. */
function recordOrders(page: Page): SentOrder[] {
  const sent: SentOrder[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/dev/orders") {
      sent.push(request.postDataJSON() as SentOrder);
    }
  });
  return sent;
}

async function openPosition(page: Page, side: "Long" | "Short"): Promise<string> {
  await page.getByRole("group", { name: "Side" }).getByRole("button", { name: side }).click();
  await page.getByLabel("Amount (nUSD)").fill("200");
  await submitOrder(page, `Place test ${side.toLowerCase()}`);
  await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 15_000 });
  const row = page.getByRole("listitem").filter({ hasText: "Close position" });
  await expect(row.getByText(side, { exact: true })).toBeVisible({ timeout: 15_000 });
  const sizeText = await row.getByText(/^[\d.]+ SOL$/).innerText();
  return sizeText.replace(" SOL", "");
}

test.describe("Closing and reducing a position", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const { opened, closing, closeWord } of [
    { opened: "Long", closing: "sell", closeWord: "Short" },
    { opened: "Short", closing: "buy", closeWord: "Long" },
  ] as const) {
    test(`Close position on a ${opened.toLowerCase()} sends a full-size reduce-only ${closing} and ends flat`, async ({
      page,
    }) => {
      await page.goto("/");
      await createAndFundWallet(page);
      const sent = recordOrders(page);

      const size = await openPosition(page, opened);
      expect(sent).toHaveLength(1);
      expect(sent[0].reduceOnly).toBeFalsy();

      await page.getByRole("button", { name: "Close position" }).click();

      const dialog = page.getByRole("dialog", { name: "Confirm order" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Market · ${closeWord} ${size} SOL`);
      expect(sent).toHaveLength(1);
      await shot(page, `01-close-${opened.toLowerCase()}-dialog`);

      await dialog.getByRole("button", { name: `Place test ${closeWord.toLowerCase()}` }).click();

      await expect.poll(() => sent.length).toBe(2);
      expect(sent[1]).toMatchObject({
        market: "NSOL-PERP",
        side: closing,
        type: "market",
        reduceOnly: true,
      });
      expect(Number(sent[1].size)).toBeCloseTo(Number(size), 6);

      await expect(page.getByText("No positions yet", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await shot(page, `02-close-${opened.toLowerCase()}-flat`);
    });
  }

  test("Reduce prefills a reduce-only ticket and neither opens the dialog nor sends an order", async ({
    page,
  }) => {
    await page.goto("/");
    await createAndFundWallet(page);
    const sent = recordOrders(page);

    const size = await openPosition(page, "Long");
    await page.getByRole("group", { name: "Side" }).getByRole("button", { name: "Long" }).click();
    await expect(page.getByLabel("Reduce only")).not.toBeChecked();

    await page.getByRole("button", { name: "Reduce", exact: true }).click();

    await expect(
      page.getByRole("group", { name: "Side" }).getByRole("button", { name: "Short" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Reduce only")).toBeChecked();
    await expect(page.getByLabel("Order type")).toHaveValue("market");
    // The row prints the size at the lot's decimals ("1.330"); the field holds
    // the position's size as the account reports it, with its padding zeros.
    // Same size, so compare the two as numbers.
    await expect
      .poll(async () => Number(await page.locator("#order-size").inputValue()))
      .toBe(Number(size));
    await expect(page.getByRole("dialog", { name: "Confirm order" })).toHaveCount(0);
    await shot(page, "03-reduce-prefilled");

    await page.waitForTimeout(1_000);
    expect(sent).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Close position" })).toBeVisible();
  });
});
