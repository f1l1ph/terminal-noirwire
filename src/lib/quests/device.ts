import { base58Of } from "../transfer/send";
import { ownerDataKeys, type KeyValueStore } from "../wallet/index";

const RENEWAL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface QuestDevice {
  deviceKey: string;
  untilMs: number;
}

export type QuestStatus = "off" | "on" | "renew";

export async function generateDeviceKey(): Promise<{ pair: CryptoKeyPair; deviceKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { pair, deviceKey: base58Of(new Uint8Array(raw)) };
}

export async function signWithDevice(pair: CryptoKeyPair, text: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(text),
  );
  return base58Of(new Uint8Array(signature));
}

export function loadDevice(storage: KeyValueStore, wallet: string): QuestDevice | null {
  try {
    const raw = storage.getItem(ownerDataKeys.questDevice(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuestDevice>;
    if (typeof parsed.deviceKey !== "string" || typeof parsed.untilMs !== "number") return null;
    return { deviceKey: parsed.deviceKey, untilMs: parsed.untilMs };
  } catch {
    return null;
  }
}

export function saveDevice(storage: KeyValueStore, wallet: string, device: QuestDevice): void {
  storage.setItem(ownerDataKeys.questDevice(wallet), JSON.stringify(device));
}

export function forgetQuestState(storage: KeyValueStore, wallet: string): void {
  storage.removeItem(ownerDataKeys.questDevice(wallet));
  storage.removeItem(ownerDataKeys.questQueue(wallet));
}

export function activeDevice(
  storage: KeyValueStore,
  wallet: string,
  nowMs: number,
): QuestDevice | null {
  const device = loadDevice(storage, wallet);
  return device && device.untilMs > nowMs ? device : null;
}

export function questStatus(storage: KeyValueStore, wallet: string, nowMs: number): QuestStatus {
  const device = loadDevice(storage, wallet);
  if (!device) return "off";
  return device.untilMs - nowMs <= RENEWAL_WINDOW_MS ? "renew" : "on";
}
