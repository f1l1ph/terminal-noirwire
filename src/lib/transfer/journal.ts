import type { SeatSend, SolanaSend } from "./verdicts";

/** The strongest status a node has ever shown for a signature. Absent means never seen. */
export type SeenStatus = "processed" | "confirmed" | "finalized";

const STRENGTH: Record<SeenStatus, number> = { processed: 1, confirmed: 2, finalized: 3 };

/**
 * Which step of a deposit through the deposit key a send is: `fund` is the
 * wallet's payment of the tokens and fee money to the key, `move` the key's own
 * move of them into the rollup, `return` the key's payment of its tokens back
 * to the wallet, `sweep` the key's payment of its spare SOL to the owner after
 * the deposit. A send without one is the single wallet-and-key transaction
 * of an earlier version of the app, or a withdrawal's.
 */
export type SendLeg = "fund" | "move" | "return" | "sweep";

/** One Solana transaction, as written down before it was broadcast. */
export interface JournalSend {
  signature: string;
  lastValidBlockHeight: number;
  status?: SeenStatus;
  at: number;
  /** The token account on Solana before it that pays, and what it was to move, in atoms as decimal text. */
  before: string;
  moved: string;
  leg?: SendLeg;
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
  /** A deposit whose last step the program refused for good: its tokens wait in the deposit key's rollup balance, and the record is kept only until every earlier send is final. */
  stranded?: true;
  createdAt: number;
  updatedAt: number;
}

/** Whether a deposit went through the deposit key in two steps, the wallet's funding and the key's move, each its own send. */
export const isStaged = (record: Pick<OperationRecord, "sends">): boolean =>
  record.sends.some((send) => send.leg === "fund" || send.leg === "move");

/** Whether a record is a payment of the deposit key's spare SOL to the owner. */
export const isKeySweep = (record: Pick<OperationRecord, "step">): boolean =>
  record.step === "sweep";

/** The sends of one step of a staged deposit. */
export const legSends = (record: Pick<OperationRecord, "sends">, leg: SendLeg): JournalSend[] =>
  record.sends.filter((send) => send.leg === leg);

export type OperationInput = Pick<OperationRecord, "id" | "kind" | "atoms" | "step"> & {
  rollupBefore?: string;
  depositKey?: string;
  /** A recovery's seat step, written with its record because it has no Solana send to write first. */
  seat?: SeatSend;
  sends: Array<
    Pick<JournalSend, "signature" | "lastValidBlockHeight" | "status" | "before" | "moved" | "leg">
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
  /**
   * Adds the signature and blockhash of the signed bytes an order key's
   * withdrawal is about to be dispatched with to its pending seat record.
   * Resolves only once durable; the bytes are dispatched after, never before.
   * Every distinct signature is kept, since a client that re-signs may have
   * had either one run; the same signature again changes nothing.
   */
  addSeatAttempt(
    owner: string,
    id: string,
    attempt: { signature: string; blockhash: string },
  ): Promise<void>;
  /** Records that a read saw the seat's rollup transaction `signature` at processed or better, so a missing status is never taken as proof afterwards. */
  markSeatSighted(owner: string, id: string, signature: string): Promise<void>;
  /** Marks the recorded seat send as landed, as a status showed it: it stays open to a later read until a finalized success. */
  markSeatLanded(owner: string, id: string): Promise<void>;
  /** Marks an order key's withdrawal as landed and final, because the trading client proved it from the account's own view. No status read decides this, so keep it apart from `markSeatLanded`. */
  markSeatProven(owner: string, id: string): Promise<void>;
  /** Marks a deposit as stranded: its seat step was refused for good. */
  markStranded(owner: string, id: string): Promise<void>;
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

    async addSeatAttempt(owner, id, attempt) {
      if (!attempt.signature || !attempt.blockhash) {
        throw new Error("The send has no signature or blockhash, so it cannot be judged later");
      }
      await storage.update(owner, id, (existing) => {
        const seat = existing?.seat;
        if (!existing || seat?.signer !== "order-key" || seat.state !== "pending") {
          throw new Error(`No pending order key withdrawal for operation ${id}`);
        }
        const attempts = seat.attempts ?? [];
        if (attempts.some((known) => known.signature === attempt.signature)) return existing;
        return {
          ...existing,
          seat: { ...seat, signature: attempt.signature, attempts: [...attempts, attempt] },
          updatedAt: now(),
        };
      });
    },

    async markSeatSighted(owner, id, signature) {
      await storage.update(owner, id, (existing) => {
        const seat = existing?.seat;
        if (!existing || !seat) return existing ?? null;
        const attempts = seat.attempts?.map((attempt) =>
          attempt.signature === signature ? { ...attempt, seen: true as const } : attempt,
        );
        const sighted =
          seat.attempts === undefined
            ? seat.signature === signature
            : seat.attempts.some((attempt) => attempt.signature === signature);
        if (!sighted) return existing;
        return {
          ...existing,
          seat: { ...seat, ...(attempts ? { attempts } : { seen: true as const }) },
          updatedAt: now(),
        };
      });
    },

    async markStranded(owner, id) {
      await storage.update(owner, id, (existing) => {
        if (!existing) throw new Error(`No recorded operation ${id}`);
        return { ...existing, stranded: true, updatedAt: now() };
      });
    },

    async markSeatProven(owner, id) {
      await storage.update(owner, id, (existing) => {
        if (!existing?.seat) throw new Error(`No recorded seat withdrawal for operation ${id}`);
        return {
          ...existing,
          seat: { ...existing.seat, state: "landed", proven: true },
          updatedAt: now(),
        };
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
