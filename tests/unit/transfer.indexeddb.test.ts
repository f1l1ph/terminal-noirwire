import { afterEach, describe, expect, it, vi } from "vitest";
import { createJournal, indexedDbStorage, type OperationRecord } from "@/lib/transfer/journal";

type Fake = {
  [key: string]: unknown;
};

/** Just the parts of IndexedDB the adapter touches; a transaction commits only when it completes. */
function fakeIndexedDb(options: { gate?: Promise<void>; failTransaction?: Error } = {}) {
  const state = { committed: new Map<string, OperationRecord & { owner: string }>() };
  const durabilities: unknown[] = [];
  const later = (run: () => void) => setTimeout(run, 0);

  const database = {
    createObjectStore: () => ({}),
    transaction(_store: string, _mode: string, init?: { durability?: string }) {
      durabilities.push(init?.durability);
      const staged = new Map(state.committed);
      let finished = false;
      const transaction: Fake = { error: null };
      const finish = async () => {
        if (finished) return;
        await options.gate;
        if (finished) return;
        finished = true;
        if (options.failTransaction) {
          transaction.error = options.failTransaction;
          (transaction.onerror as () => void)?.();
          return;
        }
        state.committed = staged;
        (transaction.oncomplete as () => void)?.();
      };
      const request = (read: () => unknown) => {
        const handle: Fake = {};
        later(() => {
          handle.result = read();
          (handle.onsuccess as () => void)?.();
          later(finish);
        });
        return handle;
      };
      const store = {
        get: (key: string[]) => request(() => staged.get(key.join(","))),
        getAll: () => request(() => [...staged.values()]),
        put: (value: OperationRecord & { owner: string }) =>
          staged.set(`${value.owner},${value.id}`, value),
        delete: (key: string[]) => staged.delete(key.join(",")),
      };
      transaction.objectStore = () => store;
      transaction.abort = () => {
        if (finished) return;
        finished = true;
        later(() => (transaction.onabort as () => void)?.());
      };
      return transaction;
    },
  };

  const factory = {
    open() {
      const handle: Fake = { result: database };
      later(() => {
        (handle.onupgradeneeded as () => void)?.();
        (handle.onsuccess as () => void)?.();
      });
      return handle;
    },
  } as unknown as IDBFactory;

  return { factory, state, durabilities };
}

const record: OperationRecord = {
  id: "op1",
  kind: "withdraw",
  atoms: "500",
  step: "shuttle",
  sends: [],
  createdAt: 1,
  updatedAt: 1,
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => vi.unstubAllGlobals());

describe("indexedDbStorage", () => {
  it("resolves only after the transaction's complete event", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { factory, state } = fakeIndexedDb({ gate });
    const storage = indexedDbStorage(factory);
    let settled = false;
    const written = storage.update("me", "op1", () => record).then(() => (settled = true));
    await pause();
    expect(settled).toBe(false);
    expect(state.committed.size).toBe(0);
    release();
    await written;
    expect(state.committed.get("me,op1")?.step).toBe("shuttle");
  });

  it("asks for strict durability", async () => {
    const { factory, durabilities } = fakeIndexedDb();
    await indexedDbStorage(factory).update("me", "op1", () => record);
    expect(durabilities).toEqual(["strict"]);
  });

  it("aborts and writes nothing when the mutator throws", async () => {
    const { factory, state } = fakeIndexedDb();
    await expect(
      indexedDbStorage(factory).update("me", "op1", () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(state.committed.size).toBe(0);
  });

  it("rejects when the transaction errors", async () => {
    const { factory, state } = fakeIndexedDb({ failTransaction: new Error("disk full") });
    const journal = createJournal(indexedDbStorage(factory));
    await expect(
      journal.record("me", {
        id: "op1",
        kind: "withdraw",
        atoms: "500",
        step: "shuttle",
        sends: [],
      }),
    ).rejects.toThrow("disk full");
    expect(state.committed.size).toBe(0);
  });

  it("lists what was committed, without the owner key", async () => {
    vi.stubGlobal("IDBKeyRange", { bound: () => ({}) });
    const { factory } = fakeIndexedDb();
    const storage = indexedDbStorage(factory);
    await storage.update("me", "op1", () => record);
    const listed = await storage.list("me");
    expect(listed).toEqual([record]);
  });
});
