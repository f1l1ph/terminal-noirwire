import { describe, expect, it } from "vitest";
import {
  createJournal,
  type JournalStorage,
  type OperationInput,
  type OperationRecord,
} from "@/lib/transfer/journal";
import { base58Of, judgeSend, recordThenBroadcast, signatureOf } from "@/lib/transfer/send";
import { tryLockOwner, type LockManagerLike } from "@/lib/transfer/lock";
import { exitOperation, seatVerdict, type ExitOperation } from "@/lib/transfer/verdicts";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

function memoryStorage(failWrites = false) {
  const rows = new Map<string, OperationRecord>();
  const storage: JournalStorage = {
    async update(owner, id, mutate) {
      if (failWrites) throw new Error("quota exceeded");
      const key = `${owner}/${id}`;
      const next = mutate(rows.get(key));
      if (next === null) rows.delete(key);
      else rows.set(key, next);
    },
    async list(owner) {
      return [...rows.entries()].filter(([key]) => key.startsWith(`${owner}/`)).map(([, v]) => v);
    },
  };
  return { storage, rows };
}

const op = (extra: Partial<OperationInput> = {}): OperationInput => ({
  id: "op1",
  kind: "withdraw",
  atoms: "500",
  step: "shuttle",
  sends: [{ signature: "sigA", lastValidBlockHeight: 1_000, before: "0", moved: "500" }],
  ...extra,
});

const clock = () => {
  let t = 100;
  return () => (t += 1);
};

describe("journal", () => {
  it("lists only operations that are not finished, for that owner", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op({ id: "a" }));
    await journal.record("me", op({ id: "b" }));
    await journal.record("other", op({ id: "c" }));
    await journal.finish("me", "a");
    expect((await journal.unfinished("me")).map((r) => r.id)).toEqual(["b"]);
  });

  it("never downgrades a status", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await journal.markSeen("me", "op1", "sigA", "confirmed");
    await journal.markSeen("me", "op1", "sigA", "processed");
    expect((await journal.unfinished("me"))[0].sends[0].status).toBe("confirmed");
    await journal.markSeen("me", "op1", "sigA", "finalized");
    expect((await journal.unfinished("me"))[0].sends[0].status).toBe("finalized");
  });

  it("keeps the strongest status when a send is recorded again", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await journal.markSeen("me", "op1", "sigA", "processed");
    await journal.record("me", op());
    const [record] = await journal.unfinished("me");
    expect(record.sends).toHaveLength(1);
    expect(record.sends[0].status).toBe("processed");
  });

  it("refuses to record a different step under an unfinished operation", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await expect(journal.record("me", op({ step: "withdraw" }))).rejects.toThrow("different");
  });

  it("is not safe to rebuild a send journaled as processed after a crash until the finalized chain is past its blockhash", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await journal.markSeen("me", "op1", "sigA", "processed");
    const [record] = await journal.unfinished("me");
    const node = (finalized: number) => ({
      getSignatureStatus: async () => ({ value: null }),
      getBlockHeight: async (commitment: "confirmed" | "finalized") =>
        commitment === "finalized" ? finalized : 1_001,
    });
    const judged = (finalized: number) =>
      judgeSend({
        journal,
        owner: "me",
        id: "op1",
        connection: node(finalized),
        send: record.sends[0],
      });
    expect(await judged(1_000)).toBe("wait");
    expect(await judged(1_001)).toBe("safe");
  });

  it("writes a fresh processed sighting back before returning the verdict", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    const [record] = await journal.unfinished("me");
    const node = (height: number, processed: boolean) => ({
      getSignatureStatus: async () => ({
        value: processed ? { err: null, confirmationStatus: "processed" } : null,
      }),
      getBlockHeight: async () => height,
    });
    const args = { journal, owner: "me", id: "op1", send: record.sends[0] };
    expect(await judgeSend({ ...args, connection: node(500, true) })).toBe("wait");
    const [stored] = await journal.unfinished("me");
    expect(stored.sends[0].status).toBe("processed");
    expect(await judgeSend({ ...args, send: stored.sends[0], connection: node(900, false) })).toBe(
      "wait",
    );
  });

  it("does not return a verdict when the sighting cannot be written back", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    const [record] = await journal.unfinished("me");
    const failing = { markSeen: async () => Promise.reject(new Error("quota exceeded")) };
    await expect(
      judgeSend({
        journal: failing,
        owner: "me",
        id: "op1",
        send: record.sends[0],
        connection: {
          getSignatureStatus: async () => ({
            value: { err: null, confirmationStatus: "processed" },
          }),
          getBlockHeight: async () => 500,
        },
      }),
    ).rejects.toThrow("quota exceeded");
  });

  it("appends a new send to the same operation and keeps its creation time", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await journal.record(
      "me",
      op({
        sends: [{ signature: "sigB", lastValidBlockHeight: 2_000, before: "500", moved: "500" }],
      }),
    );
    const [record] = await journal.unfinished("me");
    expect(record.sends.map((s) => s.signature)).toEqual(["sigA", "sigB"]);
    expect(record.createdAt).toBeLessThan(record.updatedAt);
  });

  it("throws when the storage write fails", async () => {
    const { storage } = memoryStorage(true);
    const journal = createJournal(storage, clock());
    await expect(journal.record("me", op())).rejects.toThrow("quota exceeded");
  });

  it("refuses to record a different amount under an unfinished operation", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await expect(journal.record("me", op({ atoms: "900" }))).rejects.toThrow("different amount");
  });

  it("throws on marking a send that was never recorded", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op());
    await expect(journal.markSeen("me", "op1", "nope", "processed")).rejects.toThrow(
      "No recorded send",
    );
  });
});

describe("recordThenBroadcast", () => {
  const signed = () => {
    const payer = Keypair.generate();
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    transaction.sign(payer);
    return { bytes: new Uint8Array(transaction.serialize()), signature: transaction.signature! };
  };

  it("never broadcasts when the record write fails", async () => {
    const { storage } = memoryStorage(true);
    const journal = createJournal(storage, clock());
    const calls: string[] = [];
    await expect(
      recordThenBroadcast({
        journal,
        owner: "me",
        op: { id: "op1", kind: "withdraw", atoms: "500", step: "shuttle" },
        lastValidBlockHeight: 1_000,
        before: "0",
        moved: "500",
        signedTx: signed().bytes,
        broadcast: async () => {
          calls.push("broadcast");
        },
      }),
    ).rejects.toThrow("quota exceeded");
    expect(calls).toEqual([]);
  });

  it("writes the record strictly before the broadcast, holding the transaction's own signature", async () => {
    const { storage, rows } = memoryStorage();
    const order: string[] = [];
    const journal = createJournal(
      {
        update: async (owner, id, mutate) => {
          await storage.update(owner, id, mutate);
          order.push("record");
        },
        list: storage.list,
      },
      clock(),
    );
    const tx = signed();
    const { signature } = await recordThenBroadcast({
      journal,
      owner: "me",
      op: { id: "op1", kind: "deposit", atoms: "500", step: "move-in" },
      lastValidBlockHeight: 1_234,
      before: "0",
      moved: "500",
      signedTx: tx.bytes,
      broadcast: async () => {
        order.push("broadcast");
        expect(rows.size).toBe(1);
      },
    });
    expect(order).toEqual(["record", "broadcast"]);
    expect(signature).toBe(base58Of(tx.signature));
    const [stored] = await journal.unfinished("me");
    expect(stored.sends[0]).toMatchObject({ signature, lastValidBlockHeight: 1_234 });
  });

  it("refuses a missing or non-positive-integer lastValidBlockHeight before recording or broadcasting", async () => {
    const { storage, rows } = memoryStorage();
    const journal = createJournal(storage, clock());
    const calls: string[] = [];
    for (const bad of [undefined, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        recordThenBroadcast({
          journal,
          owner: "me",
          op: { id: "op1", kind: "withdraw", atoms: "500", step: "shuttle" },
          lastValidBlockHeight: bad as unknown as number,
          before: "0",
          moved: "500",
          signedTx: signed().bytes,
          broadcast: async () => {
            calls.push("broadcast");
          },
        }),
        String(bad),
      ).rejects.toThrow("last block height");
    }
    expect(calls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("refuses an unsigned transaction before recording or broadcasting", () => {
    const unsigned = new Uint8Array(1 + 64 + 10);
    unsigned[0] = 1;
    expect(() => signatureOf(unsigned)).toThrow("not signed");
  });
});

describe("seat withdrawal record", () => {
  const seat = {
    state: "pending",
    at: "2026-10-25T10:00:00Z",
    id: "ab12",
    before: "1000",
  } as const;

  const withdrawal = async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record("me", op({ sends: [] }));
    return journal;
  };

  const asExit = (record: OperationRecord): ExitOperation => ({
    id: record.id,
    owner: "me",
    atoms: record.atoms,
    method: "shuttle",
    seat: record.seat,
    solana: [],
  });

  it("is on record, durably, before the seat transaction is sent", async () => {
    const order: string[] = [];
    const { storage } = memoryStorage();
    const journal = createJournal(
      {
        update: async (owner, id, mutate) => {
          await storage.update(owner, id, mutate);
          order.push("record");
        },
        list: storage.list,
      },
      clock(),
    );
    await journal.record("me", op({ sends: [] }));
    await journal.recordSeatSend("me", "op1", seat);
    order.push("send");
    expect(order).toEqual(["record", "record", "send"]);
    expect((await journal.unfinished("me"))[0].seat).toEqual(seat);
  });

  it("refuses a second seat withdrawal for the same operation", async () => {
    const journal = await withdrawal();
    await journal.recordSeatSend("me", "op1", seat);
    await expect(journal.recordSeatSend("me", "op1", { ...seat, id: "cd34" })).rejects.toThrow(
      "already has a seat withdrawal",
    );
  });

  it("survives the operation being recorded again", async () => {
    const journal = await withdrawal();
    await journal.recordSeatSend("me", "op1", seat);
    await journal.record("me", op());
    expect((await journal.unfinished("me"))[0].seat).toEqual(seat);
  });

  it("blocks any new withdrawal while its outcome is unknown, then resumes only to the Solana step once landed", async () => {
    const journal = await withdrawal();
    await journal.recordSeatSend("me", "op1", seat);
    const [record] = await journal.unfinished("me");
    const atoms = BigInt(record.atoms);

    expect(() =>
      exitOperation(asExit(record), { id: "new", owner: "me", atoms: 900n, method: "shuttle" }),
    ).toThrow(/may have landed/);
    const resumed = exitOperation(asExit(record), {
      id: "new",
      owner: "me",
      atoms,
      method: "shuttle",
    });
    expect(resumed.id).toBe("op1");
    expect(seatVerdict(resumed.seat, atoms, 1_000n, undefined)).toBe("ask");

    expect(seatVerdict(resumed.seat, atoms, 1_500n, undefined)).toBe("landed");
    await journal.markSeatLanded("me", "op1");
    const [landed] = await journal.unfinished("me");
    expect(landed.seat?.state).toBe("landed");
    expect(seatVerdict(landed.seat, atoms, 0n, undefined)).toBe("landed");
    expect(landed.sends).toEqual([]);
  });

  it("asks the operator after a crash between the record and the send, and sends again only on lost:<id>", async () => {
    const journal = await withdrawal();
    await journal.recordSeatSend("me", "op1", seat);
    const [record] = await journal.unfinished("me");
    const atoms = BigInt(record.atoms);
    expect(seatVerdict(record.seat, atoms, 1_000n, undefined)).toBe("ask");
    expect(seatVerdict(record.seat, atoms, 1_000n, "lost:other")).toBe("ask");
    expect(seatVerdict(record.seat, atoms, 1_000n, "lost:ab12")).toBe("send");
  });

  it("forgets a seat send the chain refused, so the withdrawal can be tried again", async () => {
    const journal = await withdrawal();
    await journal.recordSeatSend("me", "op1", seat);
    await journal.clearSeatSend("me", "op1");
    expect((await journal.unfinished("me"))[0].seat).toBeUndefined();
    await journal.recordSeatSend("me", "op1", { ...seat, id: "cd34" });
  });
});

describe("deposit record", () => {
  it("keeps the Solana delegation send and the rollup balance before it for the resume", async () => {
    const { storage } = memoryStorage();
    const journal = createJournal(storage, clock());
    await journal.record(
      "me",
      op({
        kind: "deposit",
        step: "move-in",
        rollupBefore: "7000",
        sends: [{ signature: "sigD", lastValidBlockHeight: 1_000, before: "500", moved: "500" }],
      }),
    );
    await journal.record(
      "me",
      op({ kind: "deposit", step: "move-in", rollupBefore: "9999", sends: [] }),
    );
    const [record] = await journal.unfinished("me");
    expect(record.rollupBefore).toBe("7000");
    expect(record.sends[0]).toMatchObject({ signature: "sigD", before: "500", moved: "500" });
  });
});

describe("tryLockOwner", () => {
  const fakeLocks = (): LockManagerLike => {
    const held = new Set<string>();
    return {
      request: async (name, _options, callback) => {
        if (held.has(name)) {
          await callback(null);
          return;
        }
        held.add(name);
        try {
          await callback({});
        } finally {
          held.delete(name);
        }
      },
    };
  };

  it("gives a second holder null until the first releases", async () => {
    const locks = fakeLocks();
    const first = await tryLockOwner("me", locks);
    expect(first).not.toBeNull();
    expect(await tryLockOwner("me", locks)).toBeNull();
    expect(await tryLockOwner("someone-else", locks)).not.toBeNull();
    first!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await tryLockOwner("me", locks)).not.toBeNull();
  });

  it("throws when no lock manager exists", async () => {
    await expect(tryLockOwner("me", null)).rejects.toThrow("Web Locks");
  });
});
