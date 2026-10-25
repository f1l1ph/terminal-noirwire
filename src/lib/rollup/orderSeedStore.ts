const SEED_BYTES = 32;
const IV_BYTES = 12;

/** A seed as stored: AES-GCM ciphertext and its nonce. Never the seed itself. */
export type WrappedSeed = { iv: Uint8Array; ciphertext: Uint8Array };

/**
 * The storage the seed store needs. Every write resolves only once it is
 * durably committed, and rejects when storage is unavailable or full.
 */
export interface SeedBackend {
  getKey(): Promise<CryptoKey | undefined>;
  /** Stores the wrapping key unless one is already there; false when one was. */
  addKey(key: CryptoKey): Promise<boolean>;
  getSeed(owner: string): Promise<WrappedSeed | undefined>;
  /** Stores the wrapped seed unless the owner already has one; false when it did. */
  addSeed(owner: string, wrapped: WrappedSeed): Promise<boolean>;
  deleteSeed(owner: string): Promise<void>;
}

const bufferSource = (bytes: Uint8Array) => bytes as BufferSource;

/**
 * Throws unless `key` is the key this store makes: non-extractable AES-GCM
 * 256 for encrypt and decrypt only. A stored key that is anything else is
 * never replaced (that would orphan an existing seed) and never used.
 */
function checkWrappingKey(key: CryptoKey): CryptoKey {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  const usages = [...key.usages].sort().join(",");
  if (
    key.extractable ||
    algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 ||
    usages !== "decrypt,encrypt"
  ) {
    throw new Error("the stored order seed key is not the key this terminal made");
  }
  return key;
}

async function wrappingKey(backend: SeedBackend, create: boolean): Promise<CryptoKey | null> {
  const existing = await backend.getKey();
  if (existing) return checkWrappingKey(existing);
  if (!create) return null;
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  if (await backend.addKey(fresh)) return fresh;
  const winner = await backend.getKey();
  if (!winner) throw new Error("the order seed key could not be stored");
  return checkWrappingKey(winner);
}

const ownerBinding = (owner: string) => new TextEncoder().encode(owner);

async function unwrap(key: CryptoKey, owner: string, wrapped: WrappedSeed): Promise<Uint8Array> {
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(wrapped.iv),
        additionalData: bufferSource(ownerBinding(owner)),
      },
      key,
      bufferSource(wrapped.ciphertext),
    ),
  );
  if (plain.length !== SEED_BYTES) throw new Error("the stored order seed is malformed");
  return plain;
}

export type OrderSeedStore = {
  load(owner: string): Promise<Uint8Array | null>;
  create(owner: string): Promise<Uint8Array>;
  forget(owner: string): Promise<void>;
  /** Whether the browser granted persistent storage at the last `create`; null before any. The UI warns on false. */
  persisted(): boolean | null;
};

/**
 * Per-owner random order seeds for this browser, replacing a seed derived
 * from the owner secret. The seed is wrapped under a non-extractable AES key
 * kept next to it, so no plain-text dump of storage holds the seed.
 */
export function createOrderSeedStore(
  backend: SeedBackend,
  requestPersistence: () => Promise<boolean> = async () => false,
): OrderSeedStore {
  let persisted: boolean | null = null;
  return {
    persisted: () => persisted,
    async load(owner) {
      const wrapped = await backend.getSeed(owner);
      if (!wrapped) return null;
      const key = await wrappingKey(backend, false);
      if (!key) throw new Error("the stored order seed has no key to open it");
      return unwrap(key, owner, wrapped);
    },
    /**
     * Resolves to the owner's seed only after it is committed to storage, and
     * throws when it cannot be: the caller refuses to trade rather than use a
     * seed that would be lost on reload. If another tab stored one first, that
     * one is returned.
     */
    async create(owner) {
      persisted = await requestPersistence().catch(() => false);
      const key = await wrappingKey(backend, true);
      if (!key) throw new Error("the order seed key could not be stored");
      const seed = crypto.getRandomValues(new Uint8Array(SEED_BYTES));
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: bufferSource(ownerBinding(owner)) },
          key,
          bufferSource(seed),
        ),
      );
      if (await backend.addSeed(owner, { iv, ciphertext })) return seed;
      const existing = await backend.getSeed(owner);
      if (!existing) throw new Error("the order seed could not be stored");
      return unwrap(key, owner, existing);
    },
    forget: (owner) => backend.deleteSeed(owner),
  };
}

const DATABASE = "noirwire-terminal-order-seeds";
const KEYS = "keys";
const SEEDS = "seeds";
const KEY_ID = "wrap";

/** Runs `operate` in one transaction; resolves with what it settles only on the transaction's `complete`. */
function transact<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  operate: (objects: IDBObjectStore, settle: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let value: T;
    const transaction =
      mode === "readwrite"
        ? db.transaction(store, mode, { durability: "strict" })
        : db.transaction(store, mode);
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(transaction.error ?? new Error("storage write aborted"));
    operate(transaction.objectStore(store), (settled) => {
      value = settled;
    });
  });
}

/** Adds `record`; a key that already exists is not an error, the transaction just reports false. */
function addOnce(db: IDBDatabase, store: string, record: unknown, key: string): Promise<boolean> {
  return transact<boolean>(db, store, "readwrite", (objects, settle) => {
    const request = objects.add(record, key);
    request.onsuccess = () => settle(true);
    request.onerror = (event) => {
      if (request.error?.name !== "ConstraintError") return;
      event.preventDefault();
      settle(false);
    };
  });
}

function readOne<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return transact<T | undefined>(db, store, "readonly", (objects, settle) => {
    objects.get(key).onsuccess = (event) => settle((event.target as IDBRequest<T>).result);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("browser storage is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEYS);
      request.result.createObjectStore(SEEDS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("browser storage is unavailable"));
    request.onblocked = () => reject(new Error("browser storage is blocked"));
  });
}

/** The IndexedDB backend: thin, one record per owner. */
export function indexedDbSeedBackend(): SeedBackend {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= openDatabase().catch((error: unknown) => {
      opened = null;
      throw error;
    });
    return opened;
  };
  return {
    getKey: async () => readOne<CryptoKey>(await database(), KEYS, KEY_ID),
    addKey: async (key) => addOnce(await database(), KEYS, key, KEY_ID),
    getSeed: async (owner) => readOne<WrappedSeed>(await database(), SEEDS, owner),
    addSeed: async (owner, wrapped) => addOnce(await database(), SEEDS, wrapped, owner),
    deleteSeed: async (owner) => {
      const db = await database();
      await transact<void>(db, SEEDS, "readwrite", (objects) => {
        objects.delete(owner);
      });
    },
  };
}

let shared: OrderSeedStore | null = null;
const browserPersistence = async () => navigator.storage.persist();
const store = () => (shared ??= createOrderSeedStore(indexedDbSeedBackend(), browserPersistence));

/** The owner's seed on this browser, or null when none was stored yet. */
export const loadOrderSeed = (owner: string) => store().load(owner);
/** A new random seed for `owner`, returned only once it is durably stored; throws when storage is unavailable. */
export const createOrderSeed = (owner: string) => store().create(owner);
/** Whether the browser granted persistent storage when the last seed was created; null before any. */
export const orderSeedPersisted = () => store().persisted();
/** Deletes the owner's seed from this browser. */
export const forgetOrderSeed = (owner: string) => store().forget(owner);
