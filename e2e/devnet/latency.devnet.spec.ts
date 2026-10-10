import path from "node:path";
import fs from "node:fs";
import { test, expect, type Page, type Request } from "@playwright/test";
import { loadPersistedWallet, WALLET_STORAGE_KEY } from "../support/devnetWallet";

const ORDER_COUNT = 30;
const ORDER_SIZE = "0.01";
const ROUND_TRIP_SAMPLES = 10;
const SETTLE_AFTER_RESULT_MS = 1_500;
const ROLLUP_RPC_URL = process.env.ROLLUP_RPC_URL ?? "https://devnet-tee.magicblock.app";
const RESULTS_FILE = path.join(process.cwd(), "e2e", "devnet-latency-results.json");
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

interface NetworkEvent {
  atEpochMs: number;
  label: string;
}

interface OrderWindow {
  clickEpochMs: number | null;
  resultEpochMs: number | null;
}

/**
 * Timestamps are taken inside the page, on the page's own clock: the click
 * that submits the order (capture phase, before the terminal's handler) and
 * the commit that puts the new order's first step on the witness rail. A
 * Node-side poll would round every sample up to its own polling interval.
 */
function installOrderWindowProbe(): void {
  const epochNow = () => performance.timeOrigin + performance.now();
  const firstRailStep = () =>
    document.querySelector('[aria-live="polite"] ol li')?.textContent ?? "";
  const probe: OrderWindow & { stepAtClick: string } = {
    clickEpochMs: null,
    resultEpochMs: null,
    stepAtClick: "",
  };
  (window as unknown as { orderWindow: OrderWindow }).orderWindow = probe;

  document.addEventListener(
    "click",
    (event) => {
      const button = (event.target as Element | null)?.closest?.("button");
      if (button?.textContent?.trim() !== "Place test long") return;
      probe.stepAtClick = firstRailStep();
      probe.clickEpochMs = epochNow();
      probe.resultEpochMs = null;
    },
    true,
  );

  new MutationObserver(() => {
    if (probe.clickEpochMs === null || probe.resultEpochMs !== null) return;
    const step = firstRailStep();
    if (step && step !== probe.stepAtClick) probe.resultEpochMs = epochNow();
  }).observe(document, { childList: true, characterData: true, subtree: true });
}

/** Origin and path only: a signed-in rollup URL carries its token in the query string. */
function withoutQuery(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function describeRequest(request: Request): string {
  const target = withoutQuery(request.url());
  if (request.method() !== "POST") return `${request.method()} ${target}`;
  try {
    const body = JSON.parse(request.postData() ?? "") as
      { method?: string; params?: unknown[] } | { method?: string; params?: unknown[] }[];
    const calls = Array.isArray(body) ? body : [body];
    return calls
      .map((call) => {
        const account = typeof call.params?.[0] === "string" ? call.params[0] : "";
        const subject =
          call.method !== "getAccountInfo"
            ? ""
            : account === CLOCK_SYSVAR
              ? "(clock)"
              : `(${account.slice(0, 6)})`;
        return `POST ${target} ${call.method ?? "?"}${subject}`;
      })
      .join(" + ");
  } catch {
    return `POST ${target}`;
  }
}

function recordNetwork(page: Page, events: NetworkEvent[]): void {
  page.on("request", (request) => {
    events.push({ atEpochMs: Date.now(), label: describeRequest(request) });
  });
  page.on("requestfinished", (request) => {
    events.push({ atEpochMs: Date.now(), label: `done ${describeRequest(request)}` });
  });
  page.on("websocket", (socket) => {
    const target = withoutQuery(socket.url());
    events.push({ atEpochMs: Date.now(), label: `WS open ${target}` });
    socket.on("framereceived", () => {
      events.push({ atEpochMs: Date.now(), label: `done WS push ${target}` });
    });
    socket.on("framesent", (frame) => {
      let method = "frame";
      try {
        method = (JSON.parse(String(frame.payload)) as { method?: string }).method ?? method;
      } catch {
        // Not JSON: counted as an opaque frame.
      }
      events.push({ atEpochMs: Date.now(), label: `WS send ${target} ${method}` });
    });
  });
}

async function plainRoundTripsMs(page: Page): Promise<number[]> {
  return page.evaluate(
    async ([url, samples]) => {
      const durations: number[] = [];
      for (let i = 0; i < samples; i++) {
        const startedAt = performance.now();
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        }).then((response) => response.text());
        durations.push(performance.now() - startedAt);
      }
      return durations;
    },
    [ROLLUP_RPC_URL, ROUND_TRIP_SAMPLES] as const,
  );
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    worst: Math.round(sorted[sorted.length - 1]),
  };
}

/**
 * Opt-in only (`make e2e-devnet`): click to result on screen and the
 * requests the browser makes per market order, against the real order book
 * on Solana devnet with the persisted, already funded wallet. Orders are
 * small so a run leaves a trivial position on the test account.
 */
test.describe("Devnet order latency and request count", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("market longs: click to result and requests per order", async ({ page }) => {
    const persisted = loadPersistedWallet();
    test.skip(
      !persisted,
      "No persisted devnet wallet yet - run first-minute.devnet.spec.ts once first.",
    );
    await page.addInitScript(([key, secretHex]) => window.localStorage.setItem(key, secretHex), [
      WALLET_STORAGE_KEY,
      persisted!.secretHex,
    ] as const);
    await page.addInitScript(installOrderWindowProbe);
    const events: NetworkEvent[] = [];
    recordNetwork(page, events);

    await page.goto("/");
    await expect(page.getByText("NSOL-PERP").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/[1-9][0-9,]*\.\d\d nUSD available/).or(page.getByText(/Available: [1-9]/)),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(SETTLE_AFTER_RESULT_MS);

    const roundTripsBefore = await plainRoundTripsMs(page);
    const orders: { clickToResultMs: number; beforeResult: string[]; afterResult: string[] }[] = [];

    for (let i = 0; i < ORDER_COUNT; i++) {
      // A stale mark is refused client-side; wait it out rather than
      // counting a blocked click as part of the measurement.
      await expect(page.getByLabel("Max buy price (nUSD)")).not.toHaveValue("", {
        timeout: 30_000,
      });
      await page.getByLabel("Quantity (SOL)").fill(ORDER_SIZE);
      await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Confirm order" });
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
      }
      await page.waitForFunction(
        () => (window as unknown as { orderWindow: OrderWindow }).orderWindow.resultEpochMs,
        undefined,
        { timeout: 60_000 },
      );
      // A real trader looks at the outcome before the next click; this also
      // collects the refreshes that follow a result without blocking it.
      await page.waitForTimeout(SETTLE_AFTER_RESULT_MS);

      const { clickEpochMs, resultEpochMs } = await page.evaluate(
        () => (window as unknown as { orderWindow: OrderWindow }).orderWindow,
      );
      const labelsBetween = (from: number, to: number) =>
        events
          .filter((event) => event.atEpochMs >= from && event.atEpochMs < to)
          .map((event) => `+${Math.round(event.atEpochMs - clickEpochMs!)}ms ${event.label}`);
      orders.push({
        clickToResultMs: resultEpochMs! - clickEpochMs!,
        beforeResult: labelsBetween(clickEpochMs!, resultEpochMs!),
        afterResult: labelsBetween(resultEpochMs!, resultEpochMs! + SETTLE_AFTER_RESULT_MS),
      });
    }

    const roundTripsAfter = await plainRoundTripsMs(page);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const requestsIn = (labels: string[]) =>
      labels.filter((label) => !label.includes("ms done ")).length;
    const summary = {
      network: "devnet",
      orderCount: ORDER_COUNT,
      clickToResultMs: summarize(orders.map((order) => order.clickToResultMs)),
      requestsPerOrder: {
        beforeResult: Number(
          mean(orders.map((order) => requestsIn(order.beforeResult))).toFixed(2),
        ),
        withinSettleWindowAfterResult: Number(
          mean(orders.map((order) => requestsIn(order.afterResult))).toFixed(2),
        ),
      },
      plainRoundTripMs: summarize([...roundTripsBefore, ...roundTripsAfter]),
      orders: orders.map((order) => ({
        ...order,
        clickToResultMs: Math.round(order.clickToResultMs),
      })),
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`[devnet-latency] ${JSON.stringify({ ...summary, orders: undefined })}`);
  });
});
