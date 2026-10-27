import { atomsText } from "./amount";
import type { DepositOutcome } from "./deposit";
import type { Refusal } from "./operation";
import type { WithdrawOutcome } from "./withdraw";

export interface OutcomeLine {
  tone: "ok" | "warn" | "error";
  text: string;
  /** The signature to look the transfer up by, when one is named. */
  signature?: string;
}

const REFUSALS: Record<Refusal, string> = {
  "transaction-not-allowed":
    "The transaction was not the transfer this app means to make, so it was not sent. Nothing moved.",
  "invalid-amount": "That is not an amount this transfer can take. Nothing moved.",
  "unfinished-operation":
    "Another transfer is not finished yet. Finish it first by starting it again with the same amount. Nothing new was sent.",
  "account-not-open": "This wallet has no open account on the exchange yet. Nothing moved.",
  "exchange-paused": "The exchange is paused and takes no transfers right now. Nothing moved.",
  "custody-cap":
    "Deposits are paused at the current limit. You can still trade and withdraw. Nothing moved.",
  "insufficient-usdc": "Your wallet does not hold that much USDC. Nothing moved.",
  "insufficient-sol": "Your wallet needs more SOL for network fees. Nothing moved.",
  "above-free-collateral":
    "That is more than your free collateral. Close a position or lower the amount. Nothing moved.",
  "sealed-balance-missing":
    "This account needs a private balance that cannot be made here. Nothing moved.",
  "delegated-elsewhere": "Your token balance sits with a different rollup. Nothing moved.",
  "simulation-failed":
    "The network would refuse this transaction, so it was not sent. Nothing moved.",
  "stale-price":
    "Prices are not fresh enough to withdraw right now. Try again in a few minutes. Nothing moved.",
  "rollup-refused": "The rollup refused the transfer. Nothing moved.",
  "rollup-unreadable": "Your rollup balance could not be read, so nothing was sent.",
  "send-failed":
    "The transaction did not go through and can no longer. Nothing moved. You can start again.",
  "nothing-to-return": "There is no unfinished deposit to return. Nothing was sent.",
  "nothing-to-recover": "Nothing is waiting in the rollup to be put in your account.",
  "legacy-deposit":
    "This deposit was begun by an earlier version of the app. Return it to your wallet under transfers that need attention, then deposit again. Nothing was sent.",
  "deposit-key-missing":
    "This deposit was made with a key this browser no longer holds, so it cannot be finished from here. Nothing was sent.",
  "deposit-landed": "The deposit already went through. Nothing was sent.",
  "rollup-short": "Your rollup balance holds less than that. Nothing was sent.",
  "nothing-to-dismiss": "No transfer is waiting to be dismissed.",
  "not-dismissable": "That transfer cannot be dismissed yet. Nothing was changed.",
  "record-changed":
    "This transfer already finished or changed, perhaps in another tab. Nothing was sent.",
};

/** The need for network fees in SOL as plain text, such as "0.03 SOL". */
export const solText = (lamports: number): string => {
  const text = atomsText(BigInt(lamports), 9).replace(/0+$/, "");
  return `${text.endsWith(".") ? text.slice(0, -1) : text} SOL`;
};

/** What a flow's outcome says to the user, in plain words. */
export function outcomeLine(
  kind: "deposit" | "withdraw",
  outcome: DepositOutcome | WithdrawOutcome,
  decimals: number,
  feeLamports: number,
): OutcomeLine {
  const noun = kind === "deposit" ? "deposit" : "withdrawal";
  switch (outcome.status) {
    case "done": {
      const amount = `${atomsText(outcome.atoms, decimals)} USDC`;
      return {
        tone: "ok",
        text:
          kind === "deposit"
            ? `Done: ${amount} is in your account and ready to trade.`
            : `Done: ${amount} is back in your wallet.`,
      };
    }
    case "busy":
      return {
        tone: "warn",
        text: "Another tab of this browser is already moving funds for this wallet. Finish there first.",
      };
    case "refused":
      return {
        tone: "error",
        text:
          outcome.reason === "insufficient-sol"
            ? `Your wallet needs about ${solText(feeLamports)} for network fees. Nothing moved.`
            : REFUSALS[outcome.reason],
      };
    case "waiting":
      return {
        tone: "warn",
        text: `The ${noun} is sent and still settling. Do not start another transfer until it has; it is looked at again when you come back.`,
      };
    case "not-landed":
      return {
        tone: "warn",
        text: `The ${noun} did not go through: the transaction was never shown and has expired. Nothing moved by it. You can dismiss it under transfers that need attention and start again.`,
        signature: outcome.signature,
      };
    case "unknown":
      return {
        tone: "warn",
        text: `We cannot tell what happened to this ${noun}. Wait, or contact support with the signature. Nothing is sent again.`,
        signature: outcome.signature,
      };
    case "stranded":
      return {
        tone: "warn",
        text: `${outcome.message} Under transfers that need attention, "Try the deposit again" puts it in your account.`,
      };
  }
}

/** What a thrown error says: the wallet was declined, the network check refused, or something else went wrong before anything was sent. */
export function failureLine(error: unknown): OutcomeLine {
  const reason = error instanceof Error ? error.message : "something went wrong";
  return {
    tone: "error",
    text: `The transfer stopped: ${reason.replace(/\.?$/, ".")} If part of it was already sent, it shows under transfers that need attention.`,
  };
}
