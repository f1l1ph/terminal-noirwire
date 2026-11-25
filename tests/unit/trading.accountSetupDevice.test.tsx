import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSetup } from "@/components/AccountSetup";
import { CANCELS_STOPS_NOTE } from "@/lib/trading/openCopy";
import type { OrderKeyState } from "@/lib/trading/types";

vi.mock("@/lib/env", () => ({ env: { solanaRpcUrl: null } }));

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function setupMarkup(keys: OrderKeyState): string {
  return renderToStaticMarkup(
    <AccountSetup
      address={ADDRESS}
      status="open"
      needsInvite={false}
      opening={false}
      outcome={null}
      onOpen={() => {}}
      onRecheck={async () => {}}
      keys={keys}
      onMoveHere={() => {}}
      depositsOpen
    />,
  );
}

describe("AccountSetup when the keys are on another device", () => {
  it("shows a compact card with the button, and no stops warning when none would be cancelled", () => {
    const html = setupMarkup({ stage: "elsewhere", cancelsStops: false, seedPersisted: true });
    expect(html).toContain("Trading is on another device");
    expect(html).toContain("Move trading here");
    expect(html).not.toContain(CANCELS_STOPS_NOTE);
    expect(html).not.toContain("Get ready to trade");
    expect(html).not.toContain("progressbar");
  });

  it("puts the stops warning above the button when moving would cancel triggers", () => {
    const html = setupMarkup({ stage: "elsewhere", cancelsStops: true, seedPersisted: true });
    const warning = html.indexOf(CANCELS_STOPS_NOTE);
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(html.indexOf("Move trading here"));
  });

  it("says trading moved, with the same button, after another device took over", () => {
    const html = setupMarkup({ stage: "moved", cancelsStops: true, seedPersisted: true });
    expect(html).toContain("Trading moved to another device");
    expect(html).toContain("Move trading here");
    expect(html).toContain(CANCELS_STOPS_NOTE);
  });

  it("asks for the wallet while installing and offers no button", () => {
    const html = setupMarkup({ stage: "installing", seedPersisted: true });
    expect(html).toContain("Moving trading here");
    expect(html).toContain("Approve in your wallet.");
    expect(html).not.toContain("<button");
  });

  it("keeps the failed stage and its retry", () => {
    const html = setupMarkup({ stage: "failed", reason: "It broke.", seedPersisted: true });
    expect(html).toContain("It broke.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Move trading here");
  });

  it("has no em dash in the card", () => {
    for (const keys of [
      { stage: "elsewhere", cancelsStops: true, seedPersisted: true },
      { stage: "moved", cancelsStops: true, seedPersisted: true },
      { stage: "installing", seedPersisted: true },
    ] as OrderKeyState[]) {
      expect(setupMarkup(keys)).not.toMatch(/—/);
    }
  });
});
