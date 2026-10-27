import { discriminator } from "@noirwire/orderbook";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  blockhashOf,
  hookKeyedWithdrawals,
  isKeyedWithdrawal,
  type DispatchCount,
} from "@/lib/transfer/keyedWithdrawal";
import { signatureOf } from "@/lib/transfer/send";
import { FakeRpc, signedAttempt } from "./transferWorld";

const PROGRAM = PublicKey.unique();

const order = () => {
  const key = Keypair.generate();
  const transaction = new Transaction({
    feePayer: key.publicKey,
    blockhash: PublicKey.unique().toBase58(),
    lastValidBlockHeight: 1,
  }).add(
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [{ pubkey: key.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from(discriminator("place_order")), Buffer.alloc(8)]),
    }),
  );
  transaction.sign(key);
  return transaction.serialize();
};

const rollupOf = () => new FakeRpc("rollup", []);

describe("isKeyedWithdrawal and blockhashOf", () => {
  it("knows the order book's withdrawal by order key from anything else", () => {
    expect(isKeyedWithdrawal(signedAttempt(1, PROGRAM), PROGRAM)).toBe(true);
    expect(isKeyedWithdrawal(order(), PROGRAM)).toBe(false);
    expect(isKeyedWithdrawal(signedAttempt(1, PROGRAM), PublicKey.unique())).toBe(false);
    expect(isKeyedWithdrawal(new Uint8Array(3), PROGRAM)).toBe(false);
  });

  it("reads the blockhash a transaction was signed with from its own bytes", () => {
    expect(blockhashOf(signedAttempt(1, PROGRAM, 7))).toBe(
      new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
    );
    expect(blockhashOf(signedAttempt(2, PROGRAM, 7))).toBe(
      blockhashOf(signedAttempt(1, PROGRAM, 7)),
    );
    expect(blockhashOf(signedAttempt(1, PROGRAM, 8))).not.toBe(
      blockhashOf(signedAttempt(1, PROGRAM, 7)),
    );
  });
});

describe("hookKeyedWithdrawals", () => {
  it("hands the signed bytes over before they are dispatched, and counts the dispatch after the hand-over", async () => {
    const rollup = rollupOf();
    const raw = signedAttempt(1, PROGRAM);
    const count: DispatchCount = { dispatched: 0 };
    const seen: string[] = [];
    const restore = hookKeyedWithdrawals(
      rollup,
      PROGRAM,
      async (bytes) => {
        seen.push(`signed:${signatureOf(bytes)}`);
        expect(rollup.sent).toEqual([]);
        expect(count.dispatched).toBe(0);
      },
      count,
    );
    await rollup.sendRawTransaction(raw, {});
    restore();
    expect(seen).toEqual([`signed:${signatureOf(raw)}`]);
    expect(rollup.sent).toEqual([signatureOf(raw)]);
    expect(count.dispatched).toBe(1);
  });

  it("hands over each distinct signed attempt", async () => {
    const rollup = rollupOf();
    const count: DispatchCount = { dispatched: 0 };
    const seen: string[] = [];
    const restore = hookKeyedWithdrawals(
      rollup,
      PROGRAM,
      async (bytes) => void seen.push(signatureOf(bytes)),
      count,
    );
    await rollup.sendRawTransaction(signedAttempt(1, PROGRAM), {});
    await rollup.sendRawTransaction(signedAttempt(2, PROGRAM), {});
    restore();
    expect(seen).toEqual([
      signatureOf(signedAttempt(1, PROGRAM)),
      signatureOf(signedAttempt(2, PROGRAM)),
    ]);
    expect(count.dispatched).toBe(2);
  });

  it("leaves every other transaction alone", async () => {
    const rollup = rollupOf();
    const count: DispatchCount = { dispatched: 0 };
    let handed = 0;
    const restore = hookKeyedWithdrawals(rollup, PROGRAM, async () => void (handed += 1), count);
    await rollup.sendRawTransaction(order(), {});
    restore();
    expect(handed).toBe(0);
    expect(count.dispatched).toBe(0);
    expect(rollup.sent).toHaveLength(1);
  });

  it("sends nothing and counts nothing when the signature cannot be written down", async () => {
    const rollup = rollupOf();
    const count: DispatchCount = { dispatched: 0 };
    const restore = hookKeyedWithdrawals(
      rollup,
      PROGRAM,
      async () => {
        throw new Error("journal write failed");
      },
      count,
    );
    await expect(rollup.sendRawTransaction(signedAttempt(1, PROGRAM), {})).rejects.toThrow(
      "journal write failed",
    );
    restore();
    expect(rollup.sent).toEqual([]);
    expect(count.dispatched).toBe(0);
  });

  it("gives the connection back as it was, with nothing to await", async () => {
    const rollup = rollupOf();
    const before = rollup.sendRawTransaction;
    const restore = hookKeyedWithdrawals(rollup, PROGRAM, async () => {}, { dispatched: 0 });
    expect(rollup.sendRawTransaction).not.toBe(before);
    expect(restore()).toBeUndefined();
    expect(rollup.sendRawTransaction).toBe(before);
    expect(Object.getOwnPropertyNames(rollup)).not.toContain("sendRawTransaction");
  });
});
