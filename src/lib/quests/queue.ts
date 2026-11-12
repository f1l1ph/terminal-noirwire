import { backoffDelayMs } from "../market-data/backoff";
import { ownerDataKeys, type KeyValueStore } from "../wallet/index";
import { activeDevice, loadDevice, signWithDevice, type QuestDevice } from "./device";
import type { DeviceKeyBackend } from "./keyStore";
import { ordersText, QUEST_ORDER_BATCH, type QuestOrder } from "./protocol";

export const QUEST_ORDER_MAX_AGE_MS = 10 * 60 * 1000;
const RETRY_FIRST_MS = 2_000;
const RETRY_CEILING_MS = 60_000;

interface QueuedOrder {
  market: string;
  secretHex: string;
  atMs: number;
}

type SendOutcome = "sent" | "failed" | "no-key";

interface QuestQueueOptions {
  storage: KeyValueStore;
  keys: DeviceKeyBackend;
  fetchFn: typeof fetch;
  simUrl: string;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => void;
}

export interface QuestQueue {
  enqueue(wallet: string, market: string, secretHex: string): void;
  flush(wallet: string, force?: boolean): Promise<void>;
}

export function createQuestQueue(options: QuestQueueOptions): QuestQueue {
  const { storage, keys, fetchFn, simUrl } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, delayMs) => void setTimeout(run, delayMs));
  const failures = new Map<string, number>();
  const notBefore = new Map<string, number>();
  const running = new Map<string, Promise<void>>();

  const readQueue = (wallet: string): QueuedOrder[] => {
    try {
      const parsed = JSON.parse(storage.getItem(ownerDataKeys.questQueue(wallet)) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry: Partial<QueuedOrder>): entry is QueuedOrder =>
          typeof entry?.market === "string" &&
          typeof entry?.secretHex === "string" &&
          typeof entry?.atMs === "number" &&
          now() - entry.atMs <= QUEST_ORDER_MAX_AGE_MS,
      );
    } catch {
      return [];
    }
  };

  const writeQueue = (wallet: string, entries: QueuedOrder[]): void => {
    const key = ownerDataKeys.questQueue(wallet);
    if (entries.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(entries));
  };

  const deviceReplaced = (wallet: string, device: QuestDevice): boolean =>
    loadDevice(storage, wallet)?.deviceKey !== device.deviceKey;

  const send = async (
    wallet: string,
    device: QuestDevice,
    batch: QueuedOrder[],
  ): Promise<SendOutcome> => {
    try {
      const pair = await keys.get(wallet);
      if (!pair) return "no-key";
      const orders: QuestOrder[] = batch.map((entry) => ({
        market: entry.market,
        secret: entry.secretHex,
      }));
      const signedAt = now();
      const signature = await signWithDevice(pair, ordersText(device.deviceKey, signedAt, orders));
      if (deviceReplaced(wallet, device)) return "no-key";
      const response = await fetchFn(`${simUrl}/v1/quests/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceKey: device.deviceKey, signedAt, orders, signature }),
      });
      return response.ok ? "sent" : "failed";
    } catch {
      return "failed";
    }
  };

  const drain = async (wallet: string, force: boolean): Promise<void> => {
    if (!force && now() < (notBefore.get(wallet) ?? 0)) return;
    for (;;) {
      const device = activeDevice(storage, wallet, now());
      const queued = readQueue(wallet);
      if (!device || queued.length === 0) return;
      const batch = queued.slice(0, QUEST_ORDER_BATCH);
      const outcome = await send(wallet, device, batch);
      if (deviceReplaced(wallet, device)) return;
      if (outcome === "no-key") return;
      if (outcome === "failed") {
        const attempt = (failures.get(wallet) ?? 0) + 1;
        const delayMs = backoffDelayMs(attempt, RETRY_FIRST_MS, RETRY_CEILING_MS, 2);
        failures.set(wallet, attempt);
        notBefore.set(wallet, now() + delayMs);
        schedule(() => void flush(wallet), delayMs);
        return;
      }
      failures.delete(wallet);
      notBefore.delete(wallet);
      const gone = new Set(batch.map((entry) => entry.secretHex));
      writeQueue(
        wallet,
        readQueue(wallet).filter((entry) => !gone.has(entry.secretHex)),
      );
    }
  };

  const flush = (wallet: string, force = false): Promise<void> => {
    const active = running.get(wallet);
    if (active) return active;
    const run = drain(wallet, force)
      .catch(() => {})
      .finally(() => running.delete(wallet));
    running.set(wallet, run);
    return run;
  };

  return {
    enqueue(wallet, market, secretHex) {
      try {
        if (!activeDevice(storage, wallet, now())) return;
        writeQueue(wallet, [...readQueue(wallet), { market, secretHex, atMs: now() }]);
        void flush(wallet);
      } catch {
        return;
      }
    },
    flush,
  };
}
