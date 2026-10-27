import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  isUsableWallet,
  ownerSignerFor,
  rejectedWallets,
  sessionEndReason,
} from "@/lib/wallet/standardWallet";

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

const named = (wallet: Wallet, name: string, chains?: string[]) =>
  ({ ...wallet, name, ...(chains ? { chains } : {}) }) as unknown as Wallet;

describe("the wallets that were found but cannot be used", () => {
  const reasonFor = (omit: string) =>
    rejectedWallets([named(fake(Keypair.generate(), { omit }).wallet, "Backpack")])[0]?.sentence;

  it("names a wallet that cannot sign messages", () => {
    expect(reasonFor("solana:signMessage")).toBe(
      "Backpack was found but cannot sign messages, which this app needs.",
    );
  });

  it("names a wallet that cannot sign transactions", () => {
    expect(reasonFor("solana:signTransaction")).toBe(
      "Backpack was found but cannot sign transactions, which this app needs.",
    );
  });

  it("names a wallet that cannot report account changes", () => {
    expect(reasonFor("standard:events")).toBe(
      "Backpack was found but cannot report account changes, which this app needs.",
    );
  });

  it("names a wallet that cannot connect", () => {
    expect(reasonFor("standard:connect")).toBe(
      "Backpack was found but cannot connect to a page, which this app needs.",
    );
  });

  it("names a Solana wallet that is not on mainnet", () => {
    const wallet = named(fake(Keypair.generate()).wallet, "Coinbase", ["solana:devnet"]);
    expect(rejectedWallets([wallet])).toEqual([
      { name: "Coinbase", sentence: "Coinbase was found but is not on Solana mainnet." },
    ]);
  });

  it("gives the first missing reason when several are missing", () => {
    const { wallet } = fake(Keypair.generate(), { omit: "solana:signMessage" });
    delete (wallet.features as Record<string, unknown>)["solana:signTransaction"];
    expect(rejectedWallets([named(wallet, "Backpack")])[0]?.sentence).toBe(
      "Backpack was found but cannot sign transactions, which this app needs.",
    );
  });

  it("lists only the unusable ones in a mixed list, and skips wallets for other chains", () => {
    const good = named(fake(Keypair.generate()).wallet, "Phantom");
    const bad = named(fake(Keypair.generate(), { omit: "solana:signMessage" }).wallet, "Backpack");
    const other = {
      name: "Other",
      chains: ["eip155:1"],
      accounts: [],
      features: { "standard:connect": {} },
    } as unknown as Wallet;
    expect(rejectedWallets([good, bad, other]).map((each) => each.name)).toEqual(["Backpack"]);
  });

  it("is empty when every wallet is usable", () => {
    expect(rejectedWallets([fake(Keypair.generate()).wallet])).toEqual([]);
  });
});

describe("the reason a connected session ends", () => {
  const key = (address: string) => ({ address });

  it("is none while the connected address is still offered", () => {
    expect(sessionEndReason([key("a"), key("b")], "a")).toBeNull();
  });

  it("is a switch when only other accounts are offered", () => {
    expect(sessionEndReason([key("b")], "a")).toBe("switched");
  });

  it("is a lock when no account is offered", () => {
    expect(sessionEndReason([], "a")).toBe("locked");
  });
});
