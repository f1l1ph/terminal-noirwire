import { test as base } from "@playwright/test";
import { fakeSim } from "./fakeSim";

/**
 * The suite's `test`: every spec starts against a fresh fake sim (no
 * traders, no history from the spec before it). The suite runs one spec at
 * a time (playwright.config.ts), so one fake serves them all.
 */
export const test = base.extend<{ freshSim: void }>({
  freshSim: [
    async ({}, use) => {
      await fakeSim.reset();
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
