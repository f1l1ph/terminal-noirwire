import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { mainnetOwnerSigner } from "@/lib/rollup/mainnetOwner";
import { programInstructions } from "@/lib/rollup/sdk";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import {
  chainOf,
  createMainnetTransferEnv,
  mainnetTransferPins,
  type ExchangeFacts,
} from "@/lib/transfer/mainnetEnv";
import { withComputeBudget } from "@/lib/transfer/computeBudget";
import { fundKeyInstructions, moveKeyInstructions } from "@/lib/transfer/depositKey";
import { associatedTokenAddress } from "@/lib/transfer/tokenAccounts";
import type { Journal } from "@/lib/transfer/journal";
import type { SolanaRpc } from "@/lib/transfer/solanaRpc";

const ATOMS = 2_500_000n;
const mint = new PublicKey(MAINNET_PINS.usdcMint);
const programId = new PublicKey(MAINNET_PINS.programId);

const exchange = (overrides: Partial<ExchangeFacts> = {}): ExchangeFacts => ({
  paused: false,
  custodyCap: 1_000_000_000n,
  sealed: false,
  token: { mint, custodyNonce: 7n },
  perpMarketIds: [0],
  ...overrides,
});

const rpc = {} as SolanaRpc;
const journal = {} as Journal;

function setup(wallet: (keypair: Keypair) => OwnerSigner = keypairOwnerSigner) {
  const keypair = Keypair.generate();
  const connected = wallet(keypair);
  const guarded = mainnetOwnerSigner(connected, "https://rpc.invalid", {
    solana: { getGenesisHash: async () => MAINNET_PINS.solanaGenesis },
    rollupIdentity: async () => MAINNET_PINS.validator,
  });
  return { keypair, connected, guarded };
}

const parts = (signer: OwnerSigner, facts: ExchangeFacts = exchange()) => ({
  signer,
  solana: rpc,
  rollup: rpc,
  rollupEndpoint: "https://rollup.invalid/path?token=secret",
  depositKey: Keypair.generate(),
  accountOpen: async () => true,
  readExchange: async () => facts,
  journal,
});

/** The collateral deposit the flows build, for the owner and amount. */
function seatDeposit(owner: PublicKey) {
  const transaction = new Transaction({
    feePayer: owner,
    blockhash: PublicKey.unique().toBase58(),
    lastValidBlockHeight: 100,
  });
  return transaction.add(
    programInstructions(programId).deposit(
      owner,
      associatedTokenAddress(owner, mint),
      { mint, custodyNonce: 7n },
      owner,
      { collateral: true },
      ATOMS,
    ),
  );
}

describe("the mainnet transfer env", () => {
  it("is made from the pins: program, USDC mint, validator and six decimals", async () => {
    const { guarded } = setup();
    const env = await createMainnetTransferEnv(parts(guarded));
    expect(env.pins.programId.toBase58()).toBe(MAINNET_PINS.programId);
    expect(env.mint.toBase58()).toBe(MAINNET_PINS.usdcMint);
    expect(env.validator.toBase58()).toBe(MAINNET_PINS.validator);
    expect(env.decimals).toBe(6);
    expect(env.owner.equals(guarded.publicKey)).toBe(true);
    expect(mainnetTransferPins().mint.equals(mint)).toBe(true);
  });

  it("refuses an exchange whose collateral token is not the pinned mint", async () => {
    const { guarded } = setup();
    const other = { mint: Keypair.generate().publicKey, custodyNonce: 7n };
    await expect(
      createMainnetTransferEnv(parts(guarded, exchange({ token: other }))),
    ).rejects.toThrow(/not the pinned mint/);
  });

  it("refuses a signer that is not the network-checked one", async () => {
    const { connected } = setup();
    await expect(createMainnetTransferEnv(parts(connected))).rejects.toThrow(
      /network-checked wallet signer/,
    );
  });

  it("refuses a transaction that is not the transfer asked for, before the wallet is asked", async () => {
    const { guarded, keypair } = setup();
    const signTransaction = vi.spyOn(guarded, "signTransaction");
    const env = await createMainnetTransferEnv(parts(guarded));
    const owner = keypair.publicKey;
    const wrongAmount = seatDeposit(owner);
    await expect(
      env.signChecked(wrongAmount, { kind: "seat-deposit", atoms: ATOMS + 1n }),
    ).rejects.toThrow(/Refusing to sign/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("signs the expected transaction and checks what the wallet returns", async () => {
    const { guarded, keypair } = setup();
    const env = await createMainnetTransferEnv(parts(guarded));
    const signed = await env.signChecked(seatDeposit(keypair.publicKey), {
      kind: "seat-deposit",
      atoms: ATOMS,
    });
    expect(signed.signatures.some((entry) => entry.signature !== null)).toBe(true);
  });

  it("refuses a wallet that hands back the very transaction it was given", async () => {
    const { guarded, keypair } = setup((pair) => ({
      publicKey: pair.publicKey,
      signMessage: async () => new Uint8Array(64),
      signTransaction: async (transaction) => {
        transaction.partialSign(pair);
        return transaction;
      },
    }));
    const env = await createMainnetTransferEnv(parts(guarded));
    await expect(
      env.signChecked(seatDeposit(keypair.publicKey), { kind: "seat-deposit", atoms: ATOMS }),
    ).rejects.toThrow(/Nothing was sent/);
  });

  it("refuses a wallet that changes the message it signs", async () => {
    const { guarded, keypair } = setup((pair) => ({
      publicKey: pair.publicKey,
      signMessage: async () => new Uint8Array(64),
      signTransaction: async (transaction) => {
        const changed = Transaction.from(
          transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
        );
        changed.recentBlockhash = PublicKey.unique().toBase58();
        changed.partialSign(pair);
        return changed;
      },
    }));
    const env = await createMainnetTransferEnv(parts(guarded));
    await expect(
      env.signChecked(seatDeposit(keypair.publicKey), { kind: "seat-deposit", atoms: ATOMS }),
    ).rejects.toThrow(/changed the transaction/);
  });
});

describe("the deposit key's move through the wallet", () => {
  it("keeps the key's signature when the wallet adds the owner's", async () => {
    const { guarded, keypair } = setup();
    const key = Keypair.generate();
    const env = await createMainnetTransferEnv({ ...parts(guarded), depositKey: key });
    const atoms = 2_500_000n;
    const instructions = withComputeBudget([
      ...fundKeyInstructions({
        owner: keypair.publicKey,
        key: key.publicKey,
        mint,
        decimals: 6,
        atoms,
      }),
      ...(await moveKeyInstructions({
        owner: keypair.publicKey,
        key: key.publicKey,
        mint,
        validator: new PublicKey(MAINNET_PINS.validator),
        atoms,
        sealed: false,
        first: true,
        vaultMissing: false,
      })),
    ]);
    const transaction = new Transaction({
      feePayer: keypair.publicKey,
      blockhash: PublicKey.unique().toBase58(),
      lastValidBlockHeight: 100,
    }).add(...instructions);
    transaction.partialSign(key);
    const signed = await env.signChecked(transaction, {
      kind: "key-move",
      atoms,
      sealed: false,
      key: key.publicKey,
      decimals: 6,
    });
    const signers = signed.signatures.filter((entry) => entry.signature !== null);
    expect(signers.map((entry) => entry.publicKey.toBase58()).sort()).toEqual(
      [keypair.publicKey, key.publicKey].map((entry) => entry.toBase58()).sort(),
    );
    expect(signed.verifySignatures()).toBe(true);
  });
});

describe("chainOf", () => {
  it("signs a rollup transaction with no chain and a Solana one with mainnet", () => {
    const owner = Keypair.generate().publicKey;
    expect(chainOf(seatDeposit(owner), programId)).toBeUndefined();
    const solanaOnly = new Transaction().add(
      programInstructions(PublicKey.unique()).deposit(
        owner,
        associatedTokenAddress(owner, mint),
        { mint, custodyNonce: 7n },
        owner,
        { collateral: true },
        ATOMS,
      ),
    );
    expect(chainOf(solanaOnly, programId)).toBe("solana:mainnet");
  });
});
