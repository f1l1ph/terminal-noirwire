import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import {
  SWITCH_DEVICE_STEPS,
  SWITCH_DEVICE_TITLE,
  SWITCH_DEVICE_WARNING,
} from "../src/lib/trading/openCopy";

async function openSettings(page: Page) {
  await page.goto("/");
  const cog = page.getByRole("button", { name: "Settings" });
  await cog.click();
  return { cog, menu: page.getByRole("group", { name: "Settings" }) };
}

test.describe("Settings menu", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("sits at the far right of the header and holds the display switches", async ({ page }) => {
    const { cog, menu } = await openSettings(page);
    await expect(menu).toBeVisible();

    const cogBox = await cog.boundingBox();
    const walletBox = await page.getByRole("banner").getByRole("button").first().boundingBox();
    expect(cogBox!.x + cogBox!.width).toBeGreaterThan(1440 - 24);
    expect(walletBox!.x).toBeLessThan(cogBox!.x);

    for (const name of ["Fun mode", "Screen tint", "Wizard"]) {
      await expect(menu.getByRole("switch", { name })).toHaveAttribute(
        "aria-checked",
        /true|false/,
      );
    }
  });

  test("Fun mode shows in the header pill and survives a reload, on and off", async ({ page }) => {
    const { menu } = await openSettings(page);
    const pill = page.getByRole("button", { name: "Fun mode" });
    const funSwitch = menu.getByRole("switch", { name: "Fun mode" });
    await expect(pill).toHaveAttribute("aria-pressed", "false");

    await funSwitch.click();
    await expect(funSwitch).toHaveAttribute("aria-checked", "true");
    await expect(pill).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(menu.getByRole("switch", { name: "Fun mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await menu.getByRole("switch", { name: "Fun mode" }).click();
    await expect(pill).toHaveAttribute("aria-pressed", "false");

    await page.reload();
    await expect(pill).toHaveAttribute("aria-pressed", "false");
  });

  test("the tint style choice shows only while the tint is on and survives a reload", async ({
    page,
  }) => {
    const { menu } = await openSettings(page);
    const style = menu.getByRole("radiogroup", { name: "Tint style" });
    const tint = menu.getByRole("switch", { name: "Screen tint" });
    if ((await tint.getAttribute("aria-checked")) !== "true") await tint.click();
    await expect(style).toBeVisible();
    await expect(style.getByRole("radio", { name: "Fuse" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await style.getByRole("radio", { name: "Tripwire" }).click();
    await expect(style.getByRole("radio", { name: "Tripwire" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      menu.getByRole("radiogroup", { name: "Tint style" }).getByRole("radio", { name: "Tripwire" }),
    ).toHaveAttribute("aria-checked", "true");

    await menu.getByRole("switch", { name: "Screen tint" }).click();
    await expect(menu.getByRole("radiogroup", { name: "Tint style" })).toHaveCount(0);
  });

  test("the switch-device guide traps focus and hands it back to Settings", async ({ page }) => {
    const { cog, menu } = await openSettings(page);
    await menu.getByRole("button", { name: "How to switch device" }).click();

    const dialog = page.getByRole("dialog", { name: SWITCH_DEVICE_TITLE });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("listitem")).toHaveText([...SWITCH_DEVICE_STEPS]);
    await expect(dialog.getByText(SWITCH_DEVICE_WARNING)).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(cog).toBeFocused();

    await cog.click();
    await menu.getByRole("button", { name: "How to switch device" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(cog).toBeFocused();
  });

  test("Escape and a press outside close the menu", async ({ page }) => {
    const { cog, menu } = await openSettings(page);
    await expect(menu).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(cog).toBeFocused();

    await cog.click();
    await expect(menu).toBeVisible();
    await page.mouse.click(300, 6);
    await expect(menu).toBeHidden();
  });

  test("Reset layout lives in the menu, not the footer; Privacy tools is mainnet only", async ({
    page,
  }) => {
    const { menu } = await openSettings(page);
    await expect(menu.getByRole("button", { name: "Reset layout" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Privacy tools" })).toHaveCount(0);
    await expect(page.getByRole("contentinfo").getByRole("button")).toHaveCount(0);
  });

  test("with no wallet connected the menu shows no device status line", async ({ page }) => {
    const { menu } = await openSettings(page);
    await expect(menu.getByRole("button", { name: "How to switch device" })).toBeVisible();
    await expect(menu.getByText("Trading on this device")).toHaveCount(0);
    await expect(menu.getByText("Trading on another device")).toHaveCount(0);
  });
});

test.describe("Settings menu on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the screen, has no Reset layout, and the old Fun buttons are gone", async ({
    page,
  }) => {
    const { menu } = await openSettings(page);
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(12 - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 12 + 1);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await expect(menu.getByRole("button", { name: "Reset layout" })).toHaveCount(0);
    await expect(menu.getByRole("switch", { name: "Fun mode" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fun mode" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fun mode settings" })).toHaveCount(0);
  });
});
