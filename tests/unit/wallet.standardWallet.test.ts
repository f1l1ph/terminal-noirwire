import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { isUsableWallet, ownerSignerFor } from "@/lib/wallet/standardWallet";

type MessageOutput = { signedMessage: Uint8Array; signature: Uint8Array };

function fake(
  keypair: Keypair,
  options: {
    signMessage?: (message: Uint8Array) => MessageOutput;
    omit?: string;
    chains?: string[];
    address?: string;
  } = {},
) {
  const account = {
    address: options.address ?? keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    chains: options.chains ?? ["solana:mainnet"],
    features: [],
  } as unknown as WalletAccount;
  const seenChains: unknown[] = [];
  const features: Record<string, unknown> = {
    "standard:connect": { connect: async () => ({ accounts: [account] }) },
    "standard:events": { on: () => () => {} },
    "solana:signMessage": {
      signMessage: async ({ message }: { message: Uint8Array }) => [
        (
          options.signMessage ??
          ((m) => ({ signedMessage: m, signature: nacl.sign.detached(m, keypair.secretKey) }))
        )(message),
      ],
    },
    "solana:signTransaction": {
      signTransaction: async (input: { transaction: Uint8Array; chain?: string }) => {
        seenChains.push(input.chain);
        const tx = Transaction.from(input.transaction);
        tx.partialSign(keypair);
        return [{ signedTransaction: tx.serialize() }];
      },
    },
  };
  if (options.omit) delete features[options.omit];
  const wallet = {
    name: "Fake",
    chains: ["solana:mainnet"],
    accounts: [account],
    features,
  } as unknown as Wallet;
  return { wallet, account, seenChains };
}

const message = new TextEncoder().encode("hello");

describe("the wallet list", () => {
  it("lists a wallet with connect, both signing features and mainnet", () => {
    expect(isUsableWallet(fake(Keypair.generate()).wallet)).toBe(true);
  });

  it("does not list a wallet without signMessage", () => {
    expect(isUsableWallet(fake(Keypair.generate(), { omit: "solana:signMessage" }).wallet)).toBe(
      false,
    );
  });

  it("does not list a wallet without signTransaction", () => {
    expect(
      isUsableWallet(fake(Keypair.generate(), { omit: "solana:signTransaction" }).wallet),
    ).toBe(false);
  });

  it("does not list a wallet without the change-events feature", () => {
    expect(isUsableWallet(fake(Keypair.generate(), { omit: "standard:events" }).wallet)).toBe(
      false,
    );
  });

  it("refuses an account whose address is another key's address", () => {
    const keypair = Keypair.generate();
    const { wallet, account } = fake(keypair, { address: Keypair.generate().publicKey.toBase58() });
    expect(() => ownerSignerFor(wallet, account)).toThrow();
  });

  it("does not list a wallet that is not on mainnet", () => {
    const { wallet } = fake(Keypair.generate());
    (wallet as unknown as { chains: string[] }).chains = ["solana:devnet"];
    expect(isUsableWallet(wallet)).toBe(false);
  });
});

describe("signMessage through a wallet", () => {
  it("returns a valid signature over exactly the message", async () => {
    const keypair = Keypair.generate();
    const { wallet, account } = fake(keypair);
    const signature = await ownerSignerFor(wallet, account).signMessage(message);
    expect(nacl.sign.detached.verify(message, signature, keypair.publicKey.toBytes())).toBe(true);
  });

  it("refuses when the wallet signed different bytes", async () => {
    const keypair = Keypair.generate();
    const other = new TextEncoder().encode("other");
    const { wallet, account } = fake(keypair, {
      signMessage: () => ({
        signedMessage: other,
        signature: nacl.sign.detached(other, keypair.secretKey),
      }),
    });
    await expect(ownerSignerFor(wallet, account).signMessage(message)).rejects.toThrow();
  });

  it("refuses a wallet that alters the buffer it was given in place and signs the altered bytes", async () => {
    const keypair = Keypair.generate();
    const { wallet, account } = fake(keypair, {
      signMessage: (m) => {
        m[0] ^= 1;
        return { signedMessage: m, signature: nacl.sign.detached(m, keypair.secretKey) };
      },
    });
    const input = message.slice();
    await expect(ownerSignerFor(wallet, account).signMessage(input)).rejects.toThrow();
  });

  it("refuses a signature that does not verify against the account", async () => {
    const keypair = Keypair.generate();
    const { wallet, account } = fake(keypair, {
      signMessage: (m) => ({
        signedMessage: m,
        signature: nacl.sign.detached(m, Keypair.generate().secretKey),
      }),
    });
    await expect(ownerSignerFor(wallet, account).signMessage(message)).rejects.toThrow();
  });
});

describe("signTransaction through a wallet", () => {
  it("passes the mainnet chain only when asked and none otherwise", async () => {
    const keypair = Keypair.generate();
    const { wallet, account, seenChains } = fake(keypair);
    const tx = new Transaction({
      feePayer: keypair.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const signer = ownerSignerFor(wallet, account);
    await signer.signTransaction(tx, "solana:mainnet");
    await signer.signTransaction(tx);
    expect(seenChains).toEqual(["solana:mainnet", undefined]);
  });
});
