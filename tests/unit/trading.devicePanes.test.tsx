import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDock, type Tab } from "@/components/AccountDock";
import FundsSection from "@/components/FundsSection";
import {
  ACCOUNT_NOT_SHOWN_AWAY,
  MOVE_TRADING_HERE,
  MOVING_FUNDS_AWAY_NOTE,
} from "@/lib/trading/openCopy";
import type { WalletIdentity } from "@/lib/trading/types";

vi.mock("@/lib/env", () => ({ env: { solanaRpcUrl: "http://127.0.0.1:1" } }));
vi.mock("@/components/TransferRecords", () => ({
  TransferRecords: () => <p>Pending transfer record</p>,
}));

const TABS: Tab[] = ["positions", "openOrders", "fills", "balances", "margin"];
const EMPTY_STATES = ["No positions yet", "No open orders", "No balances yet"];

function dock(tab: Tab, figuresAway: boolean): string {
  return renderToStaticMarkup(
    <AccountDock
      tab={tab}
      onTabChange={() => {}}
      positions={[]}
      openOrders={[]}
      ownFills={[]}
      balances={[]}
      collateral={null}
      marketSettings={() => undefined}
      marksByMarket={{}}
      now={0}
      hasWallet
      quoteSymbol="USDC"
      onTransfer={null}
      onClosePosition={() => {}}
      onReducePosition={() => {}}
      onCancelOrder={null}
      cancellingOrderIds={new Set()}
      figuresAway={figuresAway}
    />,
  );
}

describe("the account dock while trading is on another device", () => {
  it.each(TABS)("says the account is not shown on the %s tab", (tab) => {
    const html = dock(tab, true);
    expect(html).toContain(ACCOUNT_NOT_SHOWN_AWAY);
    for (const empty of EMPTY_STATES) expect(html).not.toContain(empty);
  });

  it("keeps the empty states for a loaded account that is truly empty", () => {
    expect(dock("positions", false)).toContain("No positions yet");
    expect(dock("openOrders", false)).toContain("No open orders");
    expect(dock("balances", false)).toContain("No balances yet");
    for (const tab of TABS) expect(dock(tab, false)).not.toContain(ACCOUNT_NOT_SHOWN_AWAY);
  });
});

const identity = {
  address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  signer: { publicKey: { toBase58: () => "x" } },
} as unknown as WalletIdentity;

function funds(tradingAway: boolean): string {
  return renderToStaticMarkup(
    <FundsSection
      identity={identity}
      rollupReader={async () => {
        throw new Error("not used");
      }}
      confirmSeat={async () => true}
      unseated={false}
      withdrawByKey={null}
      ownerAuthKnown
      accountOpen
      accountKnown
      tradingAway={tradingAway}
      collateral={null}
      onSettled={() => {}}
    />,
  );
}

describe("the funds section while trading is on another device", () => {
  it("disables starting a transfer, says why, and still shows a pending record", () => {
    const html = funds(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add or withdraw USDC/);
    expect(html).toContain(MOVING_FUNDS_AWAY_NOTE);
    expect(html).toContain(MOVE_TRADING_HERE);
    expect(html).toContain("Pending transfer record");
  });

  it("leaves the control enabled when trading is here", () => {
    const html = funds(false);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add or withdraw USDC/);
    expect(html).not.toContain(MOVING_FUNDS_AWAY_NOTE);
  });
});
