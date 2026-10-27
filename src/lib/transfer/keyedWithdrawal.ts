import "../bufferBigInt";
import { discriminator } from "@noirwire/orderbook";
import { Transaction, type PublicKey } from "@solana/web3.js";
import type { KeyWithdrawal } from "../trading/types";
import type { SolanaRpc } from "./solanaRpc";

/** The client threw having signed and dispatched nothing: no signed bytes ever reached the rollup connection, so no withdrawal can be running. */
export class NotDispatched extends Error {
  constructor(cause: unknown) {
    super("The withdrawal was stopped before anything was sent", { cause });
    this.name = "NotDispatched";
  }
}

const WITHDRAW_BY_KEY = Buffer.from(discriminator("withdraw_by_key"));

/** Whether `raw` is a signed transaction carrying the order book's withdrawal by order key. */
export function isKeyedWithdrawal(raw: Uint8Array, programId: PublicKey): boolean {
  try {
    return Transaction.from(raw).instructions.some(
      (instruction) =>
        instruction.programId.equals(programId) &&
        Buffer.from(instruction.data).subarray(0, WITHDRAW_BY_KEY.length).equals(WITHDRAW_BY_KEY),
    );
  } catch {
    return false;
  }
}

/**
 * `withdrawByKey` with the order key's signed bytes handed to `onSigned` before
 * they are dispatched. The trading client signs the withdrawal with a key held
 * in this browser and sends it through its rollup connection, which is the one
 * `currentRollup` gives; while the call runs, that connection's broadcast waits
 * for `onSigned` for any transaction that is the withdrawal and fails, sending
 * nothing, if it does. The signature is therefore on record before any node
 * can have it.
 *
 * A call that throws is `NotDispatched` only when no withdrawal reached the
 * connection and the connection is still the one the client uses; anything
 * else is rethrown as it was, because a throw says nothing about a call that
 * may already be running.
 */
export function withdrawalWatched(
  currentRollup: () => Promise<Pick<SolanaRpc, "sendRawTransaction">>,
  programId: PublicKey,
  withdrawByKey: (atoms: bigint) => Promise<KeyWithdrawal>,
): (atoms: bigint, onSigned?: (raw: Uint8Array) => Promise<void>) => Promise<KeyWithdrawal> {
  return async (atoms, onSigned) => {
    const rollup = await currentRollup();
    const own = Object.getOwnPropertyDescriptor(rollup, "sendRawTransaction");
    const send = rollup.sendRawTransaction.bind(rollup);
    let signed = 0;
    rollup.sendRawTransaction = async (raw, options) => {
      if (onSigned && isKeyedWithdrawal(raw, programId)) {
        signed += 1;
        await onSigned(raw);
      }
      return send(raw, options);
    };
    try {
      return await withdrawByKey(atoms);
    } catch (error) {
      const unchanged = (await currentRollup().catch(() => null)) === rollup;
      throw signed === 0 && unchanged ? new NotDispatched(error) : error;
    } finally {
      if (own) Object.defineProperty(rollup, "sendRawTransaction", own);
      else delete (rollup as Partial<typeof rollup>).sendRawTransaction;
    }
  };
}
