import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { createWalletSession } from "@/lib/wallet/standardWallet";
import { StaleSigner } from "@/lib/wallet/ownerSigner";

const accountOf = (keypair: Keypair) =>
  ({
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    chains: ["solana:mainnet"],
    features: [],
  }) as unknown as WalletAccount;

type Change = (event: { accounts?: readonly WalletAccount[] }) => void;

/** A wallet whose connect stays pending until `finish` is called. */
function pendingWallet(account: WalletAccount) {
  let finish: () => void = () => {};
  let emit: Change = () => {};
  let finishSigning: () => void = () => {};
  const wallet = {
    name: "Fake",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      "standard:connect": {
        connect: () =>
          new Promise((resolve) => {
            finish = () => resolve({ accounts: [account] });
          }),
      },
      "standard:events": {
        on: (_event: string, listener: Change) => {
          emit = listener;
          return () => {
            emit = () => {};
          };
        },
      },
      "standard:disconnect": { disconnect: async () => {} },
      "solana:signTransaction": { signTransaction: async () => [] },
      "solana:signMessage": {
        signMessage: () =>
          new Promise((resolve) => {
            finishSigning = () => resolve([]);
          }),
      },
    },
  } as unknown as Wallet;
  return {
    wallet,
    finish: () => finish(),
    finishSigning: () => finishSigning(),
    emit: (event: Parameters<Change>[0]) => emit(event),
  };
}

async function connected(fake: ReturnType<typeof pendingWallet>) {
  const session = createWalletSession();
  const connecting = session.connect(fake.wallet);
  fake.finish();
  await connecting;
  return { session, signer: session.snapshot().connected!.signer };
}

describe("a signature in flight", () => {
  it("is discarded when the account is switched meanwhile", async () => {
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const { signer } = await connected(fake);
    const signing = signer.signMessage(new Uint8Array([1]));
    fake.emit({ accounts: [accountOf(Keypair.generate())] });
    fake.finishSigning();
    await expect(signing).rejects.toThrow(StaleSigner);
  });

  it("is discarded when the wallet is disconnected meanwhile", async () => {
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const { session, signer } = await connected(fake);
    const signing = signer.signMessage(new Uint8Array([1]));
    await session.disconnect();
    fake.finishSigning();
    await expect(signing).rejects.toThrow(StaleSigner);
  });
});

describe("the wallet session", () => {
  it("leaves no signer when a connect finishes after a disconnect", async () => {
    const session = createWalletSession();
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const connecting = session.connect(fake.wallet);
    await session.disconnect();
    fake.finish();
    await connecting;
    expect(session.snapshot().connected).toBeNull();
  });

  it("ignores the first connect when a second one was started", async () => {
    const session = createWalletSession();
    const first = pendingWallet(accountOf(Keypair.generate()));
    const secondAccount = accountOf(Keypair.generate());
    const second = pendingWallet(secondAccount);
    const one = session.connect(first.wallet);
    const two = session.connect(second.wallet);
    second.finish();
    await two;
    first.finish();
    await one;
    expect(session.snapshot().connected?.account).toBe(secondAccount);
  });

  it("refuses a connect when the account was switched before it finished", async () => {
    const session = createWalletSession();
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const connecting = session.connect(fake.wallet);
    fake.emit({ accounts: [accountOf(Keypair.generate())] });
    fake.finish();
    await expect(connecting).rejects.toThrow();
    expect(session.snapshot().connected).toBeNull();
  });

  it("drops the signer on an account switch after connecting, and it is no longer current", async () => {
    const session = createWalletSession();
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const connecting = session.connect(fake.wallet);
    fake.finish();
    await connecting;
    const signer = session.snapshot().connected!.signer;
    expect(session.isCurrent(signer)).toBe(true);
    fake.emit({ accounts: [accountOf(Keypair.generate())] });
    expect(session.snapshot().connected).toBeNull();
    expect(session.isCurrent(signer)).toBe(false);
  });
});

describe("why a session ended", () => {
  it("names a switch and keeps the previous address", async () => {
    const account = accountOf(Keypair.generate());
    const fake = pendingWallet(account);
    const { session } = await connected(fake);
    fake.emit({ accounts: [accountOf(Keypair.generate())] });
    expect(session.snapshot().ended).toEqual({ reason: "switched", address: account.address });
  });

  it("names a lock when the wallet reports no accounts", async () => {
    const account = accountOf(Keypair.generate());
    const fake = pendingWallet(account);
    const { session } = await connected(fake);
    fake.emit({ accounts: [] });
    expect(session.snapshot().ended).toEqual({ reason: "locked", address: account.address });
    expect(session.snapshot().connected).toBeNull();
  });

  it("says nothing when the user disconnects", async () => {
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const { session } = await connected(fake);
    await session.disconnect();
    expect(session.snapshot().ended).toBeNull();
  });

  it("clears on dismiss and on the next connect", async () => {
    const fake = pendingWallet(accountOf(Keypair.generate()));
    const { session } = await connected(fake);
    fake.emit({ accounts: [] });
    session.dismissEnded();
    expect(session.snapshot().ended).toBeNull();
    fake.emit({ accounts: [] });
    const again = session.connect(fake.wallet);
    expect(session.snapshot().ended).toBeNull();
    fake.finish();
    await again;
    expect(session.snapshot().ended).toBeNull();
  });
});
