import { SystemProgram } from "@solana/web3.js";
import { MAX_KEY_TRANSFER_FEE_LAMPORTS, SWEEP_MIN_LAMPORTS } from "./computeBudget";
import { isKeySweep } from "./journal";
import {
  finishWhenFinalized,
  reconciled,
  sendJournaled,
  underLock,
  type TransferEnv,
} from "./operation";

/**
 * Pays the owner back the SOL the deposit key holds beyond what it keeps: the
 * rent of an empty account, the fees of one more key-signed payment (a later
 * return to the wallet) and the fees of this payment itself. The key's SOL may
 * still be needed while any transfer is open, so nothing is sent unless the
 * owner has no record but an earlier sweep's, and that one is judged first: it
 * is never sent again while it may still land, a landed one is closed once
 * final, and one that can never land is dropped. Dust below
 * `SWEEP_MIN_LAMPORTS` is left. Journaled before it is sent, as a record of
 * its own. Best effort: whatever goes wrong sends nothing and is tried again
 * on the next look.
 */
export function sweepKeySol(env: TransferEnv): Promise<void> {
  return underLock(env, async () => {
    try {
      const owner = env.owner.toBase58();
      const records = await env.journal.unfinished(owner);
      if (records.some((record) => !isKeySweep(record))) return;
      for (const record of records) {
        const earlier = await reconciled(env, record.id, record.sends, undefined);
        if ("status" in earlier) return;
        if (earlier.landed) await finishWhenFinalized(env, record.id);
        else await env.journal.finish(owner, record.id);
      }
      if ((await env.journal.unfinished(owner)).length > 0) return;
      const key = env.depositKey.publicKey;
      const held = await env.solana.getBalance(key, "confirmed");
      const kept =
        (await env.solana.getMinimumBalanceForRentExemption(0)) + 2 * MAX_KEY_TRANSFER_FEE_LAMPORTS;
      const lamports = held - kept;
      if (lamports < SWEEP_MIN_LAMPORTS) return;
      await sendJournaled(env, {
        id: `${env.newId()}.sweep`,
        kind: "withdraw",
        step: "sweep",
        atoms: 0n,
        instructions: [SystemProgram.transfer({ fromPubkey: key, toPubkey: env.owner, lamports })],
        shape: { kind: "key-sweep", key, lamports },
        leg: "sweep",
        before: BigInt(held),
        moved: 0n,
      });
    } catch {
      return;
    }
  }).then(() => undefined);
}
