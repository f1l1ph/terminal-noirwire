import type { OwnerSigner } from "../wallet/ownerSigner";

/** What a signature is checked against right before the wallet is asked. */
export type ExpectedNetwork = {
  /** The Solana cluster's genesis hash. */
  genesis: string;
  /** The identity of the validator that runs the rollup endpoint. */
  validator: string;
};

/** The two reads `stillTheNetwork` makes, injected so nothing here touches a network. */
export type NetworkReads = {
  /** A Solana `Connection` satisfies this. */
  solana: { getGenesisHash(): Promise<string> };
  /** The identity the rollup validator answers `getIdentity` with. */
  rollupIdentity(): Promise<string>;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Why the owner must not sign now, or null when both the Solana RPC and the
 * rollup endpoint still are what they were checked to be. Read fresh on
 * every call; any failed read refuses.
 */
export async function stillTheNetwork(
  reads: NetworkReads,
  expected: ExpectedNetwork,
): Promise<string | null> {
  if (!BASE58.test(expected.genesis) || !BASE58.test(expected.validator)) {
    return "the expected genesis hash or validator identity is empty or not base58";
  }
  try {
    const [genesis, validator] = await Promise.all([
      reads.solana.getGenesisHash(),
      reads.rollupIdentity(),
    ]);
    if (genesis !== expected.genesis) {
      return `the Solana RPC now answers with genesis ${genesis}, not ${expected.genesis}`;
    }
    if (validator !== expected.validator) {
      return `the rollup is run by ${validator}, not ${expected.validator}`;
    }
    return null;
  } catch (error) {
    return `the network could not be verified: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

/** Thrown, with the reason, when the network is not the one pinned; the wallet was never asked. */
export class NetworkRefused extends Error {
  constructor(reason: string) {
    super(`${reason}. Nothing was signed.`);
    this.name = "NetworkRefused";
  }
}

/**
 * `signer` with the network check bound into every signature: before the
 * wallet is asked for a message or a transaction, both RPCs are read fresh
 * against the pinned `expected` values, and any mismatch or failed read
 * throws `NetworkRefused`. This is the only owner signer the app should hand
 * to the code that signs.
 */
export function guardedOwnerSigner(
  signer: OwnerSigner,
  expected: ExpectedNetwork,
  reads: NetworkReads,
): OwnerSigner {
  const check = async () => {
    const reason = await stillTheNetwork(reads, expected);
    if (reason) throw new NetworkRefused(reason);
  };
  return {
    publicKey: signer.publicKey,
    async signMessage(message) {
      await check();
      return signer.signMessage(message);
    },
    async signTransaction(tx, chain) {
      await check();
      return signer.signTransaction(tx, chain);
    },
  };
}

const IDENTITY_TIMEOUT_MS = 15_000;

/** `rollupIdentity` over the rollup's JSON-RPC `getIdentity`, for the real endpoint. */
export function rpcIdentity(url: string, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    const answer = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
      cache: "no-store",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
    const body = (await answer.json()) as { result?: { identity?: unknown } | null } | null;
    const identity = body?.result?.identity;
    if (typeof identity !== "string" || identity === "") throw new Error(`${url} gave no identity`);
    return identity;
  };
}
