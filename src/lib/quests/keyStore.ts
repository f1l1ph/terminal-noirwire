export interface DeviceKeyBackend {
  get(wallet: string): Promise<CryptoKeyPair | undefined>;
  put(wallet: string, pair: CryptoKeyPair): Promise<void>;
  delete(wallet: string): Promise<void>;
}

const DB_NAME = "noirwire-terminal-quests";
const STORE = "device-keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function inStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const indexedDbDeviceKeys: DeviceKeyBackend = {
  get: (wallet) => inStore("readonly", (store) => store.get(wallet)),
  put: async (wallet, pair) => {
    await inStore("readwrite", (store) => store.put(pair, wallet));
  },
  delete: async (wallet) => {
    await inStore("readwrite", (store) => store.delete(wallet));
  },
};

export function forgetDeviceKey(wallet: string): void {
  if (typeof indexedDB === "undefined") return;
  indexedDbDeviceKeys.delete(wallet).catch(() => {});
}
