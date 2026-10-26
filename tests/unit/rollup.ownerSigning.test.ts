import { describe, expect, it, vi } from "vitest";
import {
  Keypair,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { isMainnetOwnerSigner, mainnetOwnerSigner } from "@/lib/rollup/mainnetOwner";
import { NetworkRefused } from "@/lib/rollup/networkCheck";
import { sendOwnerSigned, SignedTransactionRefused } from "@/lib/rollup/ownerSend";
import { buildRealSession } from "@/lib/rollup/session";
import { signedInReader } from "@/lib/rollup/signInToken";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";

const BLOCKHASH = "11111111111111111111111111111111";

/** A wallet that records every ask, so a test can prove it was (or was never) asked. */
function spiedWallet(keypair = Keypair.generate()) {
  const real = keypairOwnerSigner(keypair);
  const signMessage = vi.fn(real.signMessage);
  const signTransaction = vi.fn(real.signTransaction);
  const signer: OwnerSigner = { publicKey: keypair.publicKey, signMessage, signTransaction };
  return { signer, signMessage, signTransaction, keypair };
}

const healthy = {
  solana: { getGenesisHash: async () => MAINNET_PINS.solanaGenesis },
  rollupIdentity: async () => MAINNET_PINS.validator,
};

const transfer = (from: Keypair, lamports: number): TransactionInstruction =>
  SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports,
  });

function fakeConnection(options: { status?: "confirmed" | "failed" } = {}) {
  const sendRawTransaction = vi.fn(async () => "signature-1");
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 10 }),
    sendRawTransaction,
    getSignatureStatus: async () => ({
      value:
        options.status === "failed"
          ? { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }
          : { confirmationStatus: "confirmed", err: null },
    }),
  } as unknown as Connection;
  return { connection, sendRawTransaction };
}

describe("the trading path signs only through the network-checked signer", () => {
  it("marks the signer a mainnet session accepts", () => {
    const { signer } = spiedWallet();
    expect(isMainnetOwnerSigner(mainnetOwnerSigner(signer, "https://rpc.example", healthy))).toBe(
      true,
    );
  });

  it("does not mark the bare wallet signer", () => {
    expect(isMainnetOwnerSigner(spiedWallet().signer)).toBe(false);
  });

  it("builds no mainnet session from the bare wallet signer, and never asks that wallet", async () => {
    const { signer, signMessage, signTransaction, keypair } = spiedWallet();
    const fetchFn = vi.fn();
    const build = buildRealSession(
      { address: keypair.publicKey.toBase58(), signer },
      {
        simUrl: "https://sim.example",
        overrides: { pins: MAINNET_PINS },
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    );
    await expect(build).rejects.toThrow(/network-checked wallet signer/);
    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("never asks the wallet to sign in when the Solana RPC reports another cluster", async () => {
    const { signer, signMessage, keypair } = spiedWallet();
    const guarded = mainnetOwnerSigner(signer, "https://rpc.example", {
      ...healthy,
      solana: { getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
    });
    const deps = {
      rollupRpcUrl: MAINNET_PINS.rollupRpcUrl,
      owner: guarded,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      now: () => 0,
      signIn: async (
        _url: string,
        _reader: unknown,
        sign: (message: Uint8Array) => Promise<Uint8Array>,
      ) => {
        await sign(
          new TextEncoder().encode(
            `Login to Query Filtering Service\nTimestamp: 1\nUser: ${keypair.publicKey.toBase58()}`,
          ),
        );
        return { token: "token-value-0001", expiresAtMs: 10 ** 13 };
      },
      connect: () => ({}) as Connection,
    };
    await expect(signedInReader(deps)).rejects.toBeInstanceOf(NetworkRefused);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("never asks the wallet to sign a transaction when the rollup is run by another validator", async () => {
    const { signer, signTransaction, keypair } = spiedWallet();
    const guarded = mainnetOwnerSigner(signer, "https://rpc.example", {
      ...healthy,
      rollupIdentity: async () => keypair.publicKey.toBase58(),
    });
    const { connection, sendRawTransaction } = fakeConnection();
    await expect(
      sendOwnerSigned(connection, [transfer(keypair, 1)], guarded),
    ).rejects.toBeInstanceOf(NetworkRefused);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("a transaction a wallet signs is sent only if it is the one that was built", () => {
  it("sends what the wallet signed when it is unchanged", async () => {
    const { signer, keypair } = spiedWallet();
    const { connection, sendRawTransaction } = fakeConnection();
    await expect(sendOwnerSigned(connection, [transfer(keypair, 5)], signer)).resolves.toBe(
      "signature-1",
    );
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the wallet added an instruction of its own", async () => {
    const { signer, keypair } = spiedWallet();
    const greedy: OwnerSigner = {
      ...signer,
      signTransaction: async (tx) => {
        const bigger = Transaction.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        );
        bigger.add(transfer(keypair, 1_000_000));
        return keypairOwnerSigner(keypair).signTransaction(bigger);
      },
    };
    const { connection, sendRawTransaction } = fakeConnection();
    await expect(
      sendOwnerSigned(connection, [transfer(keypair, 5)], greedy),
    ).rejects.toBeInstanceOf(SignedTransactionRefused);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("sends nothing when the wallet signed a transaction paid by someone else", async () => {
    const { signer, keypair } = spiedWallet();
    const stranger = Keypair.generate();
    const swapped: OwnerSigner = {
      ...signer,
      signTransaction: async (tx) => {
        const other = new Transaction({
          feePayer: stranger.publicKey,
          blockhash: tx.recentBlockhash!,
          lastValidBlockHeight: 10,
        }).add(...tx.instructions);
        other.partialSign(keypair);
        return other;
      },
    };
    const { connection, sendRawTransaction } = fakeConnection();
    await expect(
      sendOwnerSigned(connection, [transfer(keypair, 5)], swapped),
    ).rejects.toBeInstanceOf(SignedTransactionRefused);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("sends nothing when the signature does not verify over the built message", async () => {
    const { signer, keypair } = spiedWallet();
    const forged: OwnerSigner = {
      ...signer,
      signTransaction: async (tx) => {
        const copy = Transaction.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        );
        copy.addSignature(keypair.publicKey, Buffer.alloc(64, 7));
        return copy;
      },
    };
    const { connection, sendRawTransaction } = fakeConnection();
    await expect(
      sendOwnerSigned(connection, [transfer(keypair, 5)], forged),
    ).rejects.toBeInstanceOf(SignedTransactionRefused);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects with the transaction's own error when it landed and failed", async () => {
    const { signer, keypair } = spiedWallet();
    const { connection } = fakeConnection({ status: "failed" });
    await expect(sendOwnerSigned(connection, [transfer(keypair, 5)], signer)).rejects.toThrow(
      /InstructionError/,
    );
  });
});
