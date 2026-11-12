import { base58Of } from "../transfer/send";
import { isWalletDecline } from "../wallet/declined";
import type { OwnerSigner } from "../wallet/ownerSigner";
import type { KeyValueStore } from "../wallet/index";
import {
  forgetQuestState,
  generateDeviceKey,
  loadDevice,
  saveDevice,
  signWithDevice,
} from "./device";
import type { DeviceKeyBackend } from "./keyStore";
import { consentText, QUEST_DEVICE_DAYS, revokeText } from "./protocol";

const CANT_SIGN_MESSAGE = "This wallet can't sign messages, so it can't earn quest points.";
const BROWSER_CANT_EARN = "This browser can't earn quest points.";
const QUESTS_NOT_RUNNING = "Quest points are not running right now.";
export const QUESTS_UNAVAILABLE = "Quest points could not be turned on. Try again.";

export class QuestOptInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestOptInError";
  }
}

type OptInOutcome = "on" | "declined";

export interface QuestDeps {
  storage: KeyValueStore;
  keys: DeviceKeyBackend;
  fetchFn: typeof fetch;
  simUrl: string;
  now?: () => number;
}

async function post(
  deps: QuestDeps,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetchFn(`${deps.simUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new QuestOptInError(QUESTS_UNAVAILABLE);
  }
  if (response.status === 404) throw new QuestOptInError(QUESTS_NOT_RUNNING);
  if (!response.ok) throw new QuestOptInError(QUESTS_UNAVAILABLE);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function enableQuests(
  deps: QuestDeps & { signer: OwnerSigner },
): Promise<OptInOutcome> {
  const now = deps.now ?? Date.now;
  const wallet = deps.signer.publicKey.toBase58();
  let generated: Awaited<ReturnType<typeof generateDeviceKey>>;
  try {
    generated = await generateDeviceKey();
  } catch {
    throw new QuestOptInError(BROWSER_CANT_EARN);
  }
  const { pair, deviceKey } = generated;
  const { challenge } = await post(deps, "/v1/quests/challenge", { wallet });
  if (typeof challenge !== "string") throw new QuestOptInError(QUESTS_UNAVAILABLE);
  const untilMs = now() + QUEST_DEVICE_DAYS * 24 * 60 * 60 * 1000;
  const until = new Date(untilMs).toISOString();
  const text = consentText(wallet, deviceKey, until, challenge);
  let signature: Uint8Array;
  try {
    signature = await deps.signer.signMessage(new TextEncoder().encode(text));
  } catch (error) {
    if (isWalletDecline(error)) return "declined";
    throw new QuestOptInError(CANT_SIGN_MESSAGE);
  }
  await post(deps, "/v1/quests/device", {
    wallet,
    deviceKey,
    until,
    challenge,
    signature: base58Of(signature),
  });
  try {
    await deps.keys.put(wallet, pair);
  } catch {
    throw new QuestOptInError(BROWSER_CANT_EARN);
  }
  saveDevice(deps.storage, wallet, { deviceKey, untilMs });
  return "on";
}

export async function disableQuests(
  deps: QuestDeps,
  wallet: string,
): Promise<{ revoke: Promise<void> }> {
  const now = deps.now ?? Date.now;
  const device = loadDevice(deps.storage, wallet);
  forgetQuestState(deps.storage, wallet);
  let pair: CryptoKeyPair | undefined;
  try {
    pair = await deps.keys.get(wallet);
  } catch {
    pair = undefined;
  }
  await deps.keys.delete(wallet).catch(() => {});
  if (!device || !pair) return { revoke: Promise.resolve() };
  const signedAt = now();
  const revoke = signWithDevice(pair, revokeText(device.deviceKey, signedAt))
    .then(async (signature) => {
      await post(deps, "/v1/quests/device/revoke", {
        deviceKey: device.deviceKey,
        signedAt,
        signature,
      });
    })
    .catch(() => {});
  return { revoke };
}
