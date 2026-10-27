import type { Transaction } from "@solana/web3.js";
import type { TransferShape } from "./guard";
import type { TransferEnv } from "./operation";

/** Where a transfer stands while a flow runs, in the order a step goes through them. */
export type Phase = "preparing" | "approve" | "sending" | "finality";

export const PHASE_LINES: Record<Phase, string> = {
  preparing: "Preparing the transfer",
  approve: "Approve in your wallet",
  sending: "Sending",
  finality: "Waiting for the network to confirm",
};

type Broadcaster = { sendRawTransaction: TransferEnv["solana"]["sendRawTransaction"] };

/** `rpc` with only its broadcast watched: the same object behind it, nothing else changed. */
function watchedBroadcast<T extends Broadcaster>(rpc: T, onSent: () => void): T {
  const watched = Object.create(rpc) as T;
  watched.sendRawTransaction = async (raw, options) => {
    try {
      return await rpc.sendRawTransaction(raw, options);
    } finally {
      onSent();
    }
  };
  return watched;
}

/**
 * `env` with its progress reported: "approve" while the wallet is asked to
 * sign, "sending" once it has signed, "finality" once a broadcast has been
 * handed to a node. It changes nothing about what is signed or sent.
 */
export function withProgress(env: TransferEnv, report: (phase: Phase) => void): TransferEnv {
  return {
    ...env,
    solana: watchedBroadcast(env.solana, () => report("finality")),
    rollup: watchedBroadcast(env.rollup, () => report("finality")),
    depositRollup: async () =>
      watchedBroadcast(await env.depositRollup(), () => report("finality")),
    signChecked: async (transaction: Transaction, shape: TransferShape) => {
      report("approve");
      const signed = await env.signChecked(transaction, shape);
      report("sending");
      return signed;
    },
  };
}
