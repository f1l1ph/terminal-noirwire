import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitLine } from "../../src/lib/trading/limitLine";

const chartProps: { limitLine?: LimitLine | null }[] = [];

vi.mock("@/components/MarketChart", () => ({
  MarketChart: (props: { limitLine?: LimitLine | null }) => {
    chartProps.push(props);
    return null;
  },
}));
vi.mock("@/components/MarketContextBar", () => ({ PriceHeadline: () => null }));
vi.mock("@/components/PrivacyToolsToggle", () => ({ PrivacyToolsToggle: () => null }));
vi.mock("@/components/PublicTape", () => ({ PublicTape: () => null }));
vi.mock("@/components/PublicView", () => ({ PublicView: () => null }));
vi.mock("@/components/VenuePulse", () => ({ VenuePulse: () => null }));

import { PhoneLayout } from "../../src/components/PhoneLayout";

function renderPhone(limitLine: LimitLine | null) {
  renderToStaticMarkup(
    createElement(PhoneLayout, {
      market: undefined,
      mark: null,
      now: 0,
      markets: [],
      selectedMarketId: "",
      onSelectMarket: () => {},
      phoneView: "market",
      onPhoneViewChange: () => {},
      orderEntry: null,
      witnessRail: null,
      accountDock: null,
      candles: [],
      tape: [],
      ownSequences: new Set<number>(),
      candlesLoading: false,
      stats: null,
      network: "test",
      checkPrivacy: (async () => ({})) as never,
      markStale: false,
      limitLine,
      clientDurationMs: null,
      mainnet: false,
      toolsOn: true,
      orderNotice: null,
    }),
  );
}

describe("chart limit line wiring", () => {
  beforeEach(() => {
    chartProps.length = 0;
  });

  it("hands the chart the draft price in limit mode", () => {
    renderPhone({ price: 101.5, side: "buy" });
    expect(chartProps.at(-1)?.limitLine).toEqual({ price: 101.5, side: "buy" });
  });

  it("hands the chart no price in market mode", () => {
    renderPhone(null);
    expect(chartProps.at(-1)?.limitLine).toBeNull();
  });
});
