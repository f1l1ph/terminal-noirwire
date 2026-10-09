import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "../wallet/index";
import type { WalletAccount } from "../wallet/index";

/**
 * The browser wallet's keypair IS the owner key (DESIGN.md section 4): this
 * terminal never uses a separate wallet-adapter flow, so the owner's full
 * secret key is already in hand, exactly as the SDK's own tests hold it.
 */
export function ownerKeypairFrom(wallet: WalletAccount): Keypair {
  return Keypair.fromSecretKey(hexToBytes(wallet.secretKeyHex));
}

const ORDER_SEED_DOMAIN = new TextEncoder().encode("noirwire-terminal/order-key-seed/v1");

/**
 * The 32-byte seed `OrderKeyManager` derives every order key from, drawn
 * from the owner key alone so nothing but the owner secret has to be kept:
 * sign a fixed domain-separated message with the owner key (Ed25519 signing
 * is deterministic, so this is stable across reloads and devices that import
 * the same owner secret) and hash the signature. Never the owner secret
 * itself, and never sent anywhere.
 */
export function deriveOrderSeed(owner: Keypair): Uint8Array {
  const signature = nacl.sign.detached(ORDER_SEED_DOMAIN, owner.secretKey);
  return sha256(signature);
}
