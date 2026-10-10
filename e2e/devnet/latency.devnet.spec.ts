import path from "node:path";
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { loadPersistedWallet, WALLET_STORAGE_KEY } from "../support/devnetWallet";

/**
 * Opt-in only (`make e2e-devnet`): measures, from this browser and against
 * the real order book on Solana devnet, what the eighth-pass review asked
 * for directly - click-to-result for a run of market orders (median, p95,
 * worst) and how many HTTP/WebSocket requests each one costs the browser,
 * with the system otherwise idle. Reuses the persisted wallet (see
 * `first-minute.devnet.spec.ts`); needs it already funded (run that spec
 * first on a fresh wallet). Orders are small (0.01 SOL) so twenty of them
 * leave a trivial, harmless position on a devnet test account.
 */
const ORDER_COUNT = 20;
const ORDER_SIZE = "0.01";
const RESULTS_FILE = path.join(process.cwd(), "e2e", "devnet-latency-results.json");

test.describe("Devnet order latency and request count", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("twenty market longs: click-to-result and requests per order", async ({ page }) => {
    const persisted = loadPersistedWallet();
    test.skip(
      !persisted,
      "No persisted devnet wallet yet - run first-minute.devnet.spec.ts once first.",
    );
    await page.addInitScript(([key, secretHex]) => window.localStorage.setItem(key, secretHex), [
      WALLET_STORAGE_KEY,
      persisted!.secretHex,
    ] as const);
    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/[1-9][0-9,]*\.\d\d nUSD available/).or(page.getByText(/Available: [1-9]/)),
    ).toBeVisible({
      timeout: 30_000,
    });

    const durationsMs: number[] = [];
    const requestsPerOrder: number[] = [];

    for (let i = 0; i < ORDER_COUNT; i++) {
      // A stale mark is refused client-side; wait it out rather than
      // counting a blocked click as part of the measurement.
      await expect(page.getByLabel("Max buy price (nUSD)")).not.toHaveValue("", {
        timeout: 30_000,
      });

      let requestCount = 0;
      const onRequest = () => {
        requestCount++;
      };
      page.on("request", onRequest);

      const before = await page
        .getByText(/This order · .*click to result/)
        .first()
        .innerText()
        .catch(() => "");

      await page.getByLabel("Quantity (SOL)").fill(ORDER_SIZE);
      const clickedAt = Date.now();
      await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Confirm order" });
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
      }
      await expect
        .poll(
          async () =>
            page
              .getByText(/This order · .*click to result/)
              .first()
              .innerText()
              .catch(() => ""),
          { timeout: 60_000 },
        )
        .not.toBe(before);
      const resultAt = Date.now();
      page.off("request", onRequest);

      durationsMs.push(resultAt - clickedAt);
      requestsPerOrder.push(requestCount);

      // Let the result settle fully (fills, balances) before the next
      // click, same as a real trader waiting to see the outcome.
      await page.waitForTimeout(500);
    }

    durationsMs.sort((a, b) => a - b);
    const median = durationsMs[Math.floor(durationsMs.length / 2)];
    const p95 =
      durationsMs[Math.min(durationsMs.length - 1, Math.floor(durationsMs.length * 0.95))];
    const worst = durationsMs[durationsMs.length - 1];
    const avgRequests = requestsPerOrder.reduce((a, b) => a + b, 0) / requestsPerOrder.length;

    const summary = {
      network: "devnet",
      orderCount: ORDER_COUNT,
      clickToResultMs: { median, p95, worst, samples: durationsMs },
      requestsPerOrder: { average: avgRequests, samples: requestsPerOrder },
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`[devnet-latency] ${JSON.stringify(summary)}`);
  });
});
