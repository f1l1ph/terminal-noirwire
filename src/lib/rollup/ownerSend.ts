import { Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { MainnetChain, OwnerSigner } from "../wallet/ownerSigner";
import { redactToken } from "./redact";
import { signedDiffers } from "./signedCheck";

/** The wallet returned something other than the transaction it was given. Nothing was sent. */
export class SignedTransactionRefused extends Error {
  /** The refusal without the closing sentence, for a caller that words the whole line itself. */
  readonly reason: string;

  constructor(reason: string) {
    super(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Nothing was sent.`);
    this.name = "SignedTransactionRefused";
    this.reason = reason;
  }
}

/**
 * The owner's signature on `built`, accepted only when what the signer hands
 * back is that very transaction: the message is serialized before the signer
 * is asked, and the result is compared against those bytes (`signedDiffers`).
 * Every transaction an external wallet signs goes through here.
 */
export async function signChecked(
  signer: OwnerSigner,
  built: Transaction,
  chain?: MainnetChain,
): Promise<Transaction> {
  const builtMessage = built.serializeMessage();
  const signed = await (chain
    ? signer.signTransaction(built, chain)
    : signer.signTransaction(built));
  const reason = signedDiffers(built, builtMessage, signed, signer.publicKey);
  if (reason) {
    if (process.env.NODE_ENV !== "production") {
      logRefusedCapture(reason, chain, builtMessage, signed);
    }
    throw new SignedTransactionRefused(reason);
  }
  return signed;
}

/** Development builds only: what the wallet handed back, for building an exact acceptance rule. */
function logRefusedCapture(
  reason: string,
  chain: MainnetChain | undefined,
  builtMessage: Uint8Array,
  signed: Transaction,
) {
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  console.info("wallet changed the transaction: capture", {
    reason,
    chain,
    builtMessageBase64: base64(builtMessage),
    signedMessageBase64: base64(signed.serializeMessage()),
    signers: signed.signatures.map((entry) => ({
      publicKey: entry.publicKey.toBase58(),
      signed: entry.signature !== null,
    })),
  });
}

const CONFIRM_TIMEOUT_MS = 60_000;
const STATUS_POLL_MS = { first: 100, growth: 1.5, slowest: 1_000 };

export interface SendTiming {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds a transaction of `instructions` paid by the owner on `connection`'s
 * latest blockhash, has the owner sign it through `signChecked`, sends it
 * and waits for its status. The status is asked for less and less often, down
 * to once a second. Rejects with the transaction's own error when it landed
 * and failed, and when it was not confirmed in time.
 */
export async function sendOwnerSigned(
  connection: Connection,
  instructions: TransactionInstruction[],
  signer: OwnerSigner,
  { now = Date.now, sleep = wait }: SendTiming = {},
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const built = new Transaction({ feePayer: signer.publicKey, ...latest }).add(...instructions);
  const signed = await signChecked(signer, built);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
  });
  const deadline = now() + CONFIRM_TIMEOUT_MS;
  let pollMs = STATUS_POLL_MS.first;
  while (now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (!value.err) return signature;
      throw new Error(redactToken(JSON.stringify(value.err)));
    }
    await sleep(pollMs);
    pollMs = Math.min(STATUS_POLL_MS.slowest, pollMs * STATUS_POLL_MS.growth);
  }
  throw new Error(`transaction ${signature} was not confirmed in ${CONFIRM_TIMEOUT_MS} ms`);
}
