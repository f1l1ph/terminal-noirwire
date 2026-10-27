import { discriminator } from "@noirwire/orderbook";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  NotDispatched,
  isKeyedWithdrawal,
  withdrawalWatched,
} from "@/lib/transfer/keyedWithdrawal";
import { signatureOf } from "@/lib/transfer/send";
import { FakeRpc } from "./transferWorld";

const PROGRAM = PublicKey.unique();

/** Signed bytes of one instruction with the given data, as the SDK sends them. */
function signedWith(data: Buffer, programId = PROGRAM) {
  const key = Keypair.generate();
  const transaction = new Transaction({
    feePayer: key.publicKey,
    blockhash: PublicKey.unique().toBase58(),
    lastValidBlockHeight: 1,
  }).add(
    new TransactionInstruction({
      programId,
      keys: [{ pubkey: key.publicKey, isSigner: true, isWritable: false }],
      data,
    }),
  );
  transaction.sign(key);
  return transaction.serialize();
}

const withdrawal = () =>
  signedWith(Buffer.concat([Buffer.from(discriminator("withdraw_by_key")), Buffer.alloc(8)]));
const order = () =>
  signedWith(Buffer.concat([Buffer.from(discriminator("place_order")), Buffer.alloc(8)]));

const rollupOf = () => new FakeRpc("rollup", []);

describe("isKeyedWithdrawal", () => {
  it("knows the order book's withdrawal by order key from anything else", () => {
    expect(isKeyedWithdrawal(withdrawal(), PROGRAM)).toBe(true);
    expect(isKeyedWithdrawal(order(), PROGRAM)).toBe(false);
    expect(isKeyedWithdrawal(withdrawal(), PublicKey.unique())).toBe(false);
    expect(isKeyedWithdrawal(new Uint8Array(3), PROGRAM)).toBe(false);
  });
});

describe("withdrawalWatched", () => {
  it("hands the signed bytes over before they are dispatched, once the signature is theirs", async () => {
    const rollup = rollupOf();
    const raw = withdrawal();
    const seen: string[] = [];
    const watched = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        await rollup.sendRawTransaction(raw, {});
        return { kind: "withdrawn" };
      },
    );
    const result = await watched(1n, async (bytes) => {
      seen.push(`signed:${signatureOf(bytes)}`);
      expect(rollup.sent).toEqual([]);
    });
    expect(result).toEqual({ kind: "withdrawn" });
    expect(seen).toEqual([`signed:${signatureOf(raw)}`]);
    expect(rollup.sent).toEqual([signatureOf(raw)]);
  });

  it("leaves every other transaction alone", async () => {
    const rollup = rollupOf();
    let handed = 0;
    const watched = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        await rollup.sendRawTransaction(order(), {});
        return { kind: "withdrawn" };
      },
    );
    await watched(1n, async () => {
      handed += 1;
    });
    expect(handed).toBe(0);
    expect(rollup.sent).toHaveLength(1);
  });

  it("sends nothing when the signature cannot be written down", async () => {
    const rollup = rollupOf();
    const watched = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        await rollup.sendRawTransaction(withdrawal(), {});
        return { kind: "withdrawn" };
      },
    );
    await expect(
      watched(1n, async () => {
        throw new Error("journal write failed");
      }),
    ).rejects.toThrow("journal write failed");
    expect(rollup.sent).toEqual([]);
  });

  it("gives the connection back as it was", async () => {
    const rollup = rollupOf();
    const before = rollup.sendRawTransaction;
    const watched = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        throw new Error("x");
      },
    );
    await expect(watched(1n, async () => {})).rejects.toBeDefined();
    expect(rollup.sendRawTransaction).toBe(before);
    expect(Object.getOwnPropertyNames(rollup)).not.toContain("sendRawTransaction");
  });

  it("calls a throw before any signed bytes NotDispatched, and only then", async () => {
    const rollup = rollupOf();
    const boom = new Error("failed to fetch");
    const before = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        throw boom;
      },
    );
    const refused = await before(1n, async () => {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotDispatched);
    expect((refused as NotDispatched).cause).toBe(boom);

    const after = withdrawalWatched(
      async () => rollup,
      PROGRAM,
      async () => {
        await rollup.sendRawTransaction(withdrawal(), {});
        throw boom;
      },
    );
    await expect(after(1n, async () => {})).rejects.toBe(boom);
  });

  it("does not vouch for a call when the connection it watched is no longer the client's", async () => {
    const first = rollupOf();
    const second = rollupOf();
    let reads = 0;
    const boom = new Error("session refreshed");
    const watched = withdrawalWatched(
      async () => (reads++ === 0 ? first : second),
      PROGRAM,
      async () => {
        throw boom;
      },
    );
    await expect(watched(1n, async () => {})).rejects.toBe(boom);
  });
});
