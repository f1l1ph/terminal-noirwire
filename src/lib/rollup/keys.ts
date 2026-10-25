import type { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { refuseOnMainnet } from "../network";
import type { OwnerSigner } from "../wallet/ownerSigner";
import type { SignMessage } from "./sdk";

const ORDER_SEED_DOMAIN = new TextEncoder().encode("noirwire-terminal/order-key-seed/v2");
const ED25519_SEED_BYTES = 32;

/**
 * The 32-byte seed `OrderKeyManager` derives every order key from, drawn
 * from the owner key alone so nothing but the owner secret has to be kept:
 * sha256 over a domain tag and the owner's 32-byte Ed25519 seed. Stable
 * across reloads and across devices that import the same owner secret.
 *
 * It is a hash of the secret, never a signature: the owner key signs
 * messages other people choose (the rollup's sign-in challenge), so a seed
 * that was a signature over a fixed message could be obtained by anyone who
 * got the owner key to sign that message. The seed itself is never sent.
 */
export function deriveOrderSeed(owner: Keypair): Uint8Array {
  refuseOnMainnet("Deriving the order seed from the owner secret");
  const input = new Uint8Array(ORDER_SEED_DOMAIN.length + ED25519_SEED_BYTES);
  input.set(ORDER_SEED_DOMAIN);
  input.set(owner.secretKey.slice(0, ED25519_SEED_BYTES), ORDER_SEED_DOMAIN.length);
  return sha256(input);
}

const LEGACY_ORDER_SEED_DOMAIN = new TextEncoder().encode("noirwire-terminal/order-key-seed/v1");

/**
 * The seed earlier builds derived (a hash of the owner's signature over a
 * fixed message), computed here only to recognise an account whose view
 * still holds keys from it, so they can be replaced at once. Never used to
 * sign anything: anyone who got the owner key to sign that message, as the
 * rollup sign-in once could, may hold this seed.
 */
export function deriveLegacyOrderSeed(owner: Keypair): Uint8Array {
  refuseOnMainnet("Deriving the earlier order seed from the owner secret");
  return sha256(nacl.sign.detached(LEGACY_ORDER_SEED_DOMAIN, owner.secretKey));
}

/**
 * The one challenge MagicBlock's query filter issues, the hosted devnet
 * endpoint and the local `query-filtering-service` 0.1.3 alike:
 * "Login to Query Filtering Service\nTimestamp: <unix seconds>\nUser: <pubkey>".
 */
const SIGN_IN_CHALLENGE = /^Login to Query Filtering Service\nTimestamp: (\d{1,16})\nUser: (\S+)$/;

/**
 * Whether `message` is a rollup sign-in challenge for `owner`, the only
 * thing the sign-in signer will sign. MagicBlock's SDK signs the endpoint's
 * challenge string verbatim as UTF-8, so the signer accepts exactly the
 * filter's template, naming this owner and nobody else, and refuses
 * anything else an endpoint might send instead: a transaction, another
 * site's sign-in text, or this terminal's own domain tags.
 */
export function isSignInChallenge(message: Uint8Array, owner: PublicKey): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(message);
  } catch {
    return false;
  }
  const match = SIGN_IN_CHALLENGE.exec(text);
  return match !== null && match[2] === owner.toBase58();
}

/**
 * The owner's signer for the rollup sign-in, refusing anything that is not a
 * sign-in challenge for this owner. The only use of `signMessage` anywhere.
 */
export function signInSigner(owner: OwnerSigner): SignMessage {
  return async (message) => {
    if (!isSignInChallenge(message, owner.publicKey)) {
      throw new Error("the rollup asked this wallet to sign something that is not a sign-in");
    }
    return owner.signMessage(message);
  };
}
