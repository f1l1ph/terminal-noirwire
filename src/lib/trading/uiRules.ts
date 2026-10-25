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

export type TradeGate = "needsAccount" | "accountUnknown" | "keysNotReady" | "keysFailed";

/**
 * Why an order cannot be placed yet on a mainnet build. Fails closed: null
 * only when the account is positively open and the order keys are ready;
 * an unknown or unread state of either is a gate. Test builds are never gated.
 */
export function tradeGate(
  mainnet: boolean,
  status: AccountStatus,
  keys: OrderKeyState | null,
): TradeGate | null {
  if (!mainnet) return null;
  if (status === "absent") return "needsAccount";
  if (status !== "open") return "accountUnknown";
  if (keys?.stage === "failed") return "keysFailed";
  if (!keys || keys.stage !== "ready") return "keysNotReady";
  return null;
}

const GATE_LABELS: Record<TradeGate, string> = {
  keysFailed: "Trading keys not set up",
  needsAccount: "Open your account to trade",
  accountUnknown: "Checking your account…",
  keysNotReady: "Setting up trading keys…",
};

export const tradeGateLabel = (gate: TradeGate): string => GATE_LABELS[gate];
