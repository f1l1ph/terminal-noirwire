import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { isWalletDecline } from "../wallet/declined";
import type { OwnerSigner } from "../wallet/ownerSigner";
import { sendRawAndConfirm, SentTransactionFailed, type SendTiming } from "./ownerSend";
import { PROGRAM_ERROR, WIRE_ERROR_OFFSET } from "./refusals";
import {
  OWNER_ERROR_CODE,
  TraderClient,
  ownerActionExpiry,
  ownerActionText,
  ownerSignatureForm,
  rollupClockSeconds,
  signedKeyReplacement,
  type OrderKeyManager,
  type OwnerMessageForm,
  type View,
} from "./sdk";

const SIGNATURE_BYTES = 64;
const VIEW_SHOWS_KEYS_WITHIN_MS = 15_000;
const VIEW_POLL_MS = 500;

const OTHER_DEVICE = "Your account changed on another device. Reload and try again.";

/** The action the wallet is asked to consent to, with everything its message must say. */
export interface ExpectedOwnerAction {
  action: "open" | "replace";
  programId: PublicKey;
  /** The four order keys the action installs. */
  keys: PublicKey[];
  expiresAt: bigint;
  /** The view's owner nonce the replacement is for; absent for an open. */
  nonce?: number;
}

/** A refusal with a sentence fit to show as it is. Nothing was sent. */
export class OwnerActionRefused extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`${reason}. Nothing was sent.`);
    this.name = "OwnerActionRefused";
    this.reason = reason;
  }
}

/** A refusal whose sentence is complete as it stands, for something that may have been sent. */
export class OwnerActionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerActionFailed";
  }
}

/** Whether the wallet's error is the owner turning the request down. */
export const messageDeclined = (error: unknown): boolean =>
  !(error instanceof OwnerActionRefused || error instanceof OwnerActionFailed) &&
  isWalletDecline(error);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

/**
 * The owner's signature over `message`, asked of the wallet only when the
 * message is exactly the one `expected` calls for, rebuilt here from the
 * signer's own address; and returned only when it verifies, as the text itself
 * or as its off-chain envelope. A wallet can hand back anything, and a bad
 * signature would cost a failed attempt. `form` says which bytes it covers.
 */
export async function signOwnerAction(
  owner: OwnerSigner,
  message: Uint8Array,
  expected: ExpectedOwnerAction,
): Promise<{ signature: Uint8Array; form: OwnerMessageForm }> {
  const wanted = ownerActionText(
    expected.action,
    expected.programId,
    owner.publicKey,
    expected.keys,
    expected.expiresAt,
    expected.nonce,
  );
  if (!sameBytes(wanted, message)) {
    throw new OwnerActionRefused("the message is not the one this account action asks you to sign");
  }
  const signature = await owner.signMessage(message);
  if (signature.length !== SIGNATURE_BYTES) {
    throw new OwnerActionRefused("your wallet did not return a signature");
  }
  const form = ownerSignatureForm(message, signature, owner.publicKey, expected.programId);
  if (!form) throw new OwnerActionRefused("your wallet's signature does not match the message");
  return { signature, form };
}

/** The program's custom error number a failed transaction carries, or null. */
function failedCode(error: unknown): number | null {
  if (!(error instanceof SentTransactionFailed)) return null;
  const instruction = (error.err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(instruction)) return null;
  const custom = (instruction[1] as { Custom?: unknown } | undefined)?.Custom;
  return typeof custom === "number" ? custom : null;
}

/** An owner action the program refused, in words for the trader; any other failure as it came. */
function plainFailure(error: unknown): unknown {
  switch (failedCode(error)) {
    case OWNER_ERROR_CODE.invalidProof:
      return new OwnerActionFailed(
        "Your wallet's signature did not match. Try again. If it keeps failing, your wallet cannot sign account messages.",
      );
    case OWNER_ERROR_CODE.expiryTooFar:
      return new OwnerActionFailed(
        "The request was refused for carrying a wrong time. Reload and try again.",
      );
    case WIRE_ERROR_OFFSET + PROGRAM_ERROR.expired:
      return new OwnerActionFailed("That took too long. Approve the message within two minutes.");
    default:
      return error;
  }
}

const holdsKeys = (view: View, keys: PublicKey[]) =>
  view.orderKeys.length === keys.length && view.orderKeys.every((key, at) => key.equals(keys[at]));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Replaces the four order keys a view holds by a message the owner signs, so
 * the wallet never sees a transaction. The signed replacement is sent with a
 * throwaway key as fee payer (the rollup charges none, and the owner does not
 * sign). Another device that replaced the keys first makes the program answer
 * with a wrong nonce: the view is read again, and if it shows these keys the
 * work is done, otherwise the message is signed once more for the new nonce.
 */
export async function installOrderKeysSigned(
  connection: Connection,
  owner: OwnerSigner,
  keys: OrderKeyManager,
  programId: PublicKey,
  { now = Date.now, sleep = wait }: SendTiming = {},
): Promise<void> {
  const wanted = keys.publicKeys;
  const readView = () =>
    new TraderClient(connection, connection, owner.publicKey, keys, programId, {
      push: false,
    }).view();
  for (let attempt = 1; ; attempt += 1) {
    const view = await readView();
    if (holdsKeys(view, wanted)) return;
    const nonce = view.ownerNonce;
    const expiresAt = ownerActionExpiry(await rollupClockSeconds(connection));
    const expected: ExpectedOwnerAction = {
      action: "replace",
      programId,
      keys: wanted,
      expiresAt,
      nonce,
    };
    const { signature, form } = await signOwnerAction(
      owner,
      ownerActionText("replace", programId, owner.publicKey, wanted, expiresAt, nonce),
      expected,
    );
    const signed = await signedKeyReplacement(connection, programId, Keypair.generate(), {
      owner: owner.publicKey,
      orderKeys: wanted,
      nonce,
      expiresAt,
      signature,
      form,
    });
    try {
      await sendRawAndConfirm(connection, signed.raw, { now, sleep });
    } catch (error) {
      if (failedCode(error) !== OWNER_ERROR_CODE.wrongNonce) throw plainFailure(error);
      if (holdsKeys(await readView(), wanted)) return;
      if (attempt >= 2) throw new OwnerActionFailed(OTHER_DEVICE);
      continue;
    }
    const deadline = now() + VIEW_SHOWS_KEYS_WITHIN_MS;
    while (!holdsKeys(await readView(), wanted)) {
      if (now() > deadline) {
        throw new OwnerActionFailed(
          "The new trading keys do not show yet. Reload in a moment to check.",
        );
      }
      await sleep(VIEW_POLL_MS);
    }
    return;
  }
}
