import type { AccountStatus, OrderKeyState } from "./types";

/** Test funds, the faucet and the built-in test wallet exist on test builds only. */
export const offersTestFunds = (mainnet: boolean): boolean => !mainnet && !!TEST_ONLY_COPY;

export const offersSpotTrading = (mainnet: boolean): boolean => !mainnet;

export interface WalletlessAction {
  label: string;
  /** Test builds create a wallet from the button; a mainnet build can only ask for one to be connected. */
  disabled: boolean;
}

/**
 * Every string that talks about test wallets, test funds or the faucet. The
 * build-time network check in the initializer lets the bundler drop the whole
 * object from a mainnet build, so none of this wording ships there.
 */
export const TEST_ONLY_COPY =
  process.env.NEXT_PUBLIC_NETWORK === "mainnet"
    ? null
    : ({
        createWallet: "Create test wallet",
        dockText: "Create a test wallet to see your account.",
        placeVerb: "Place test",
        noFaucetLabel: "No test funds on this deployment",
        getFundsLabel: "Get test funds",
        noFaucetNotice:
          "This deployment has no faucet, so it hands out no test funds. You can still follow the market, its chart and its public fills here.",
        accountErrorLead: " and test funds are",
      } as const);

/** The order form's primary action while no wallet is connected. */
export function walletlessAction(mainnet: boolean): WalletlessAction {
  return mainnet || !TEST_ONLY_COPY
    ? { label: "Connect a wallet to trade", disabled: true }
    : { label: TEST_ONLY_COPY.createWallet, disabled: false };
}

export const walletlessDockText = (mainnet: boolean): string =>
  mainnet || !TEST_ONLY_COPY ? "Connect a wallet to see your account." : TEST_ONLY_COPY.dockText;

export const placeLabel = (actionWord: string, mainnet: boolean): string =>
  mainnet || !TEST_ONLY_COPY ? `Place ${actionWord}` : `${TEST_ONLY_COPY.placeVerb} ${actionWord}`;

export type TradeGate = "needsAccount" | "keysNotReady";

/**
 * Why an order cannot be placed yet on a mainnet build: the account is not
 * open, or this device's order keys are still being set up. Null when
 * neither is known to be in the way (an unreadable account is a separate,
 * existing block).
 */
export function tradeGate(
  mainnet: boolean,
  status: AccountStatus,
  keys: OrderKeyState | null,
): TradeGate | null {
  if (!mainnet) return null;
  if (status === "absent") return "needsAccount";
  if (keys && keys.stage !== "ready") return "keysNotReady";
  return null;
}

export const tradeGateLabel = (gate: TradeGate): string =>
  gate === "needsAccount" ? "Open your account to trade" : "Setting up trading keys…";
