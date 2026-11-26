import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { createAndFundWallet, createWallet } from "./support/actions";
import { EVENT_SCHEMA } from "../src/lib/analytics";

type Recorded = [string, Record<string, unknown> | undefined];

async function installUmamiStub(page: Page): Promise<void> {
  await page.route(/umami/i, (route) => route.abort());
  await page.addInitScript(() => {
    const events: [string, unknown][] = [];
    const w = window as unknown as { __events: typeof events; umami: unknown };
    w.__events = events;
    Object.defineProperty(window, "umami", {
      configurable: false,
      get: () => ({
        track: (name: string, data?: unknown) => {
          events.push([name, data]);
        },
      }),
      set: () => {},
    });
  });
}

async function recorded(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __events: Recorded[] }).__events);
}

function named(events: Recorded[], name: string): Recorded[] {
  return events.filter(([event]) => event === name);
}

test.describe("Analytics: what the terminal sends", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("sends ticket, blocked, submitted and result events, and nothing private", async ({
    page,
  }) => {
    await installUmamiStub(page);
    await page.goto("/");
    await expect(page.getByText("SOL-PERP").first()).toBeVisible();
    await createAndFundWallet(page);

    await expect.poll(async () => named(await recorded(page), "ticket_seen").length).toBe(1);

    // A reason that only flashes while typing is never counted.
    const amount = page.getByLabel("Amount (nUSD)");
    await amount.fill("0.01");
    await expect(page.getByText(/Too small to trade/)).toBeVisible();
    await amount.fill("200");
    await expect(page.getByRole("term").filter({ hasText: "Margin used" })).toBeVisible();
    await page.waitForTimeout(2_600);
    expect(named(await recorded(page), "order_blocked")).toEqual([]);

    // A reason that stays on screen is counted once.
    await amount.fill("99999999");
    await expect(page.getByText(/More than your available/)).toBeVisible();
    await expect
      .poll(async () => named(await recorded(page), "order_blocked").length, { timeout: 6_000 })
      .toBe(1);
    await page.waitForTimeout(2_600);
    const blocked = named(await recorded(page), "order_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0][1]).toMatchObject({ reason: "over_available" });

    await amount.fill("200");
    await page.getByRole("button", { name: "Place test long", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm order" });
    await dialog.getByRole("button", { name: "Place test long", exact: true }).click();
    await expect(page.getByText("Filled", { exact: true })).toBeVisible({ timeout: 15_000 });

    const events = await recorded(page);
    expect(named(events, "ticket_seen")).toHaveLength(1);
    expect(named(events, "order_submitted")).toHaveLength(1);
    expect(named(events, "order_submitted")[0][1]).toMatchObject({ type: "market" });
    const results = named(events, "order_result");
    expect(results).toHaveLength(1);
    expect(results[0][1]).toMatchObject({ result: "filled" });

    assertPrivate(events);
    console.log("RECORDED_ORDER_RUN " + JSON.stringify(events));
  });

  test("counts uncaught errors and rejections by kind, at most three per page load", async ({
    page,
  }) => {
    await installUmamiStub(page);
    await page.goto("/");
    await expect(page.getByText("SOL-PERP").first()).toBeVisible();
    await createWallet(page);

    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("secret 12345678901234567890 boom");
      }, 0);
    });
    await expect.poll(async () => named(await recorded(page), "app_error").length).toBe(1);
    await page.evaluate(() => {
      setTimeout(() => {
        void Promise.reject(new Error("rejected 9999999999999"));
      }, 0);
    });
    await expect.poll(async () => named(await recorded(page), "app_error").length).toBe(2);

    await page.evaluate(() => {
      for (let i = 0; i < 5; i += 1) {
        setTimeout(() => {
          throw new Error(`again ${i}`);
        }, i * 5);
      }
    });
    await page.waitForTimeout(800);

    const errors = named(await recorded(page), "app_error");
    expect(errors).toHaveLength(3);
    expect(errors[0][1]).toMatchObject({ kind: "uncaught" });
    expect(errors[1][1]).toMatchObject({ kind: "rejection" });
    expect(errors[2][1]).toMatchObject({ kind: "uncaught" });

    assertPrivate(await recorded(page));
    console.log("RECORDED_ERROR_RUN " + JSON.stringify(await recorded(page)));
  });
});

/** Every recorded payload carries only its event's schema keys plus `v`, each value from its closed list, and nothing shaped like an amount, address or id. */
function assertPrivate(events: Recorded[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const [name, data] of events) {
    expect(Object.hasOwn(EVENT_SCHEMA, name), `unknown event ${name}`).toBe(true);
    const schema: Record<string, readonly string[]> =
      EVENT_SCHEMA[name as keyof typeof EVENT_SCHEMA];
    const payload = data ?? {};
    const { v, ...rest } = payload as Record<string, unknown>;
    expect(typeof v === "string" && (v === "dev" || /^[0-9a-f]{7}$/.test(v)), `${name} v`).toBe(
      true,
    );
    for (const key of Object.keys(rest)) {
      expect(Object.keys(schema), `${name} has unexpected key ${key}`).toContain(key);
    }
    for (const [key, value] of Object.entries(payload)) {
      expect(typeof value, `${name}.${key}`).toBe("string");
      const text = String(value);
      expect(text).not.toMatch(/\d{9,}/);
      expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
      if (key !== "v") expect(schema[key], `${name}.${key} value ${text}`).toContain(text);
    }
  }
}
