import "../bufferBigInt";
import { discriminator } from "@noirwire/orderbook";
import { Transaction, type Connection, type PublicKey } from "@solana/web3.js";

/** The client threw having dispatched nothing: no signed bytes of the withdrawal ever reached the rollup connection's broadcast, so no withdrawal can be running. */
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

/** The blockhash a signed transaction was signed with, read from its own bytes. */
export function blockhashOf(raw: Uint8Array): string {
  const blockhash = Transaction.from(raw).recentBlockhash;
  if (!blockhash) throw new Error("The transaction carries no blockhash");
  return blockhash;
}

/** How many of the withdrawal's signed transactions were handed to the connection's real broadcast. */
export interface DispatchCount {
  dispatched: number;
}

/**
 * Makes `connection` hand every signed withdrawal by order key to `onSigned`
 * before it is dispatched, and fail without sending if `onSigned` fails.
 * `count.dispatched` goes up just before the real broadcast is called, so it
 * counts transactions that may be running and never one a failed `onSigned`
 * stopped. The trading client signs with a key held in this browser and sends
 * through this connection, so the signed bytes are on record before any node
 * can have them. Returns the function that gives the connection back as it
 * was; it awaits nothing.
 */
export function hookKeyedWithdrawals(
  connection: Pick<Connection, "sendRawTransaction">,
  programId: PublicKey,
  onSigned: (raw: Uint8Array) => Promise<void>,
  count: DispatchCount,
): () => void {
  const own = Object.getOwnPropertyDescriptor(connection, "sendRawTransaction");
  const send = connection.sendRawTransaction.bind(connection);
  connection.sendRawTransaction = async (raw, options) => {
    if (isKeyedWithdrawal(raw instanceof Uint8Array ? raw : Uint8Array.from(raw), programId)) {
      await onSigned(raw instanceof Uint8Array ? raw : Uint8Array.from(raw));
      count.dispatched += 1;
    }
    return send(raw, options);
  };
  return () => {
    if (own) Object.defineProperty(connection, "sendRawTransaction", own);
    else delete (connection as Partial<typeof connection>).sendRawTransaction;
  };
}
