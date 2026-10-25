import {
  refuse,
  rollupSendState,
  underLock,
  type Refused,
  type Stopped,
  type TransferEnv,
} from "./operation";

export type DismissOutcome = Stopped | { status: "dismissed"; id: string; signature?: string };

/**
 * Closes the record of a rollup send that did not go through or cannot be
 * placed, once the user has looked at it. It only ever closes the record: the
 * transaction is never sent again, and if it later landed after all, the
 * balances will show it. A send that landed, that failed (already cleared) or
 * that may still land is not dismissable.
 */
export function dismissRollupSend(env: TransferEnv): Promise<DismissOutcome> {
  return underLock(env, async (): Promise<DismissOutcome | Refused> => {
    const owner = env.owner.toBase58();
    const records = await env.journal.unfinished(owner);
    const record = records.find((candidate) => candidate.seat?.state === "pending");
    if (!record?.seat) {
      return refuse(
        "nothing-to-dismiss",
        "No rollup send is waiting on record. Nothing was changed.",
      );
    }
    const state = await rollupSendState(env, record.seat);
    if (state.kind !== "not-seen") {
      return refuse(
        "not-dismissable",
        "Only a rollup send that is past its blockhash's life and was read as absent can be dismissed. This one landed, failed, may still land or could not be read. Nothing was changed.",
      );
    }
    await env.journal.clearSeatSend(owner, record.id);
    return { status: "dismissed", id: record.id, signature: record.seat.signature };
  });
}
