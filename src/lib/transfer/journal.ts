import type { SeatSend, SolanaSend } from "./verdicts";

/** The strongest status a node has ever shown for a signature. Absent means never seen. */
export type SeenStatus = "processed" | "confirmed" | "finalized";

const STRENGTH: Record<SeenStatus, number> = { processed: 1, confirmed: 2, finalized: 3 };

/** One Solana transaction, as written down before it was broadcast. */
export interface JournalSend {
  signature: string;
  lastValidBlockHeight: number;
  status?: SeenStatus;
  at: number;
  /** The owner's token account on Solana before it, and what it was to move, in atoms as decimal text. */
  before: string;
  moved: string;
}

export interface OperationRecord {
  id: string;
  kind: "deposit" | "withdraw";
  /** The amount in atoms as decimal text. */
  atoms: string;
  step: string;
  sends: JournalSend[];
  /** A withdrawal's seat step, written before the seat's transaction is sent. */
  seat?: SeatSend;
  /** A deposit's rollup balance before the move in, in atoms as decimal text: the move landed once the rollup holds this plus the amount. */
  rollupBefore?: string;
  /** A deposit's deposit key, as a public key: the tokens went into the rollup as that key's balance, and the same key credits them to the account. */
  depositKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type OperationInput = Pick<OperationRecord, "id" | "kind" | "atoms" | "step"> & {
  rollupBefore?: string;
  depositKey?: string;
  /** A recovery's seat step, written with its record because it has no Solana send to write first. */
  seat?: SeatSend;
  sends: Array<
    Pick<JournalSend, "signature" | "lastValidBlockHeight" | "status" | "before" | "moved">
  >;
};

/**
 * Where records live. `update` reads, changes and writes one record in a
 * single transaction and resolves only once that transaction is durable;
 * `mutate` returns the record to keep, or null to delete it.
 */
export interface JournalStorage {
  update(
    owner: string,
    id: string,
    mutate: (existing: OperationRecord | undefined) => OperationRecord | null,
  ): Promise<void>;
  list(owner: string): Promise<OperationRecord[]>;
}

export interface Journal {
  record(owner: string, op: OperationInput): Promise<void>;
  unfinished(owner: string): Promise<OperationRecord[]>;
  markSeen(owner: string, id: string, signature: string, status: SeenStatus): Promise<void>;
  finish(owner: string, id: string): Promise<void>;
  /**
   * Writes the seat's withdrawal down as pending, with the rollup balance
   * before it. Resolves only once durable; the caller sends the seat
   * transaction after, never before. Refuses when the operation already has a
   * seat send, since a second withdrawal could pay out twice.
   */
  recordSeatSend(owner: string, id: string, seat: SeatSend): Promise<void>;
  /** Marks the recorded seat send as landed. */
  markSeatLanded(owner: string, id: string): Promise<void>;
  /** Drops a seat send the chain refused outright (it moved nothing). */
  clearSeatSend(owner: string, id: string): Promise<void>;
}

/**
 * The send as the verdict reads it. A send the journal holds with any seen
 * status was seen as processed at least once, so it is never dropped on a
 * later missing status: the journal is the only source of that fact.
 */
export const toSolanaSend = (send: JournalSend): SolanaSend => ({
  signature: send.signature,
  lastValidBlockHeight: send.lastValidBlockHeight,
  everProcessed: send.status !== undefined,
});

const stronger = (a: SeenStatus | undefined, b: SeenStatus | undefined) =>
  (a ? STRENGTH[a] : 0) >= (b ? STRENGTH[b] : 0) ? a : b;

/**
 * The write-ahead record of money-moving sends. `record` resolves only after
 * the storage transaction is complete and throws on any failure: the caller
 * must not broadcast then. Statuses only ever strengthen, since a send seen as
 * processed must never later be read as unseen.
 */
export function createJournal(storage: JournalStorage, now: () => number = Date.now): Journal {
  return {
    async record(owner, op) {
      await storage.update(owner, op.id, (existing) => {
        if (
          existing &&
          (existing.atoms !== op.atoms || existing.kind !== op.kind || existing.step !== op.step)
        ) {
          throw new Error(
            `Operation ${op.id} is already recorded with a different amount, kind or step`,
          );
        }
        const sends = [...(existing?.sends ?? [])];
        for (const incoming of op.sends) {
          const at = sends.findIndex((send) => send.signature === incoming.signature);
          if (at === -1) {
            sends.push({ ...incoming, at: now() });
          } else {
            sends[at] = {
              ...sends[at],
              status: stronger(sends[at].status, incoming.status),
            };
          }
        }
        return {
          ...existing,
          id: op.id,
          kind: op.kind,
          atoms: op.atoms,
          step: op.step,
          rollupBefore: existing?.rollupBefore ?? op.rollupBefore,
          depositKey: existing?.depositKey ?? op.depositKey,
          seat: existing?.seat ?? op.seat,
          sends,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
      });
    },

    unfinished: (owner) => storage.list(owner),

    async markSeen(owner, id, signature, status) {
      await storage.update(owner, id, (existing) => {
        const send = existing?.sends.find((candidate) => candidate.signature === signature);
        if (!existing || !send)
          throw new Error(`No recorded send ${signature} for operation ${id}`);
        return {
          ...existing,
          sends: existing.sends.map((candidate) =>
            candidate === send ? { ...send, status: stronger(send.status, status) } : candidate,
          ),
          updatedAt: now(),
        };
      });
    },

    async finish(owner, id) {
      await storage.update(owner, id, () => null);
    },

    async recordSeatSend(owner, id, seat) {
      await storage.update(owner, id, (existing) => {
        if (!existing) throw new Error(`No recorded operation ${id}`);
        if (existing.seat)
          throw new Error(`Operation ${id} already has a seat withdrawal on record`);
        return { ...existing, seat, updatedAt: now() };
      });
    },

    async markSeatLanded(owner, id) {
      await storage.update(owner, id, (existing) => {
        if (!existing?.seat) throw new Error(`No recorded seat withdrawal for operation ${id}`);
        return { ...existing, seat: { ...existing.seat, state: "landed" }, updatedAt: now() };
      });
    },

    async clearSeatSend(owner, id) {
      await storage.update(owner, id, (existing) => {
        if (!existing) throw new Error(`No recorded operation ${id}`);
        const cleared = { ...existing, updatedAt: now() };
        delete cleared.seat;
        return cleared;
      });
    },
  };
}

const DB_NAME = "terminal-transfer";
const STORE = "operations";

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: ["owner", "id"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** Settles when the transaction has completed (data on disk), not when a request succeeded. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
}

type Stored = OperationRecord & { owner: string };

/** The real storage: one object store keyed by owner and operation id, written with strict durability. */
export function indexedDbStorage(factory: IDBFactory = indexedDB): JournalStorage {
  const database = openDatabase(factory);
  return {
    async update(owner, id, mutate) {
      const db = await database;
      const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
      const done = completed(transaction);
      const store = transaction.objectStore(STORE);
      let refusal: unknown;
      const read = store.get([owner, id]);
      read.onsuccess = () => {
        try {
          const next = mutate(read.result as Stored | undefined);
          if (next === null) store.delete([owner, id]);
          else store.put({ ...next, owner });
        } catch (error) {
          refusal = error;
          transaction.abort();
        }
      };
      try {
        await done;
      } catch (error) {
        throw refusal ?? error;
      }
    },

    async list(owner) {
      const db = await database;
      const transaction = db.transaction(STORE, "readonly");
      const done = completed(transaction);
      const request = transaction
        .objectStore(STORE)
        .getAll(IDBKeyRange.bound([owner, ""], [owner, "￿"]));
      await done;
      return (request.result as Stored[]).map((stored) => {
        const record: Partial<Stored> = { ...stored };
        delete record.owner;
        return record as OperationRecord;
      });
    },
  };
}
