import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { generateDeviceKey, loadDevice, questStatus, saveDevice } from "@/lib/quests/device";
import type { DeviceKeyBackend } from "@/lib/quests/keyStore";
import {
  dismissInvite,
  inviteDismissed,
  recordInvite,
  shouldOpenQuestDialog,
} from "@/lib/quests/invite";
import { disableQuests, enableQuests } from "@/lib/quests/optIn";
import { consentText, ordersText, revokeText } from "@/lib/quests/protocol";
import { createQuestQueue, QUEST_ORDER_MAX_AGE_MS } from "@/lib/quests/queue";
import { clearWallet, ownerDataKeys, type KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";

const SIM = "https://sim.test";
const START = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const WALLET_A = Keypair.generate().publicKey.toBase58();
const WALLET_B = Keypair.generate().publicKey.toBase58();

function memoryStorage(): KeyValueStore & { size(): number } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    size: () => map.size,
  };
}

function memoryKeys(): DeviceKeyBackend {
  const pairs = new Map<string, CryptoKeyPair>();
  return {
    get: async (wallet) => pairs.get(wallet),
    put: async (wallet, pair) => void pairs.set(wallet, pair),
    delete: async (wallet) => void pairs.delete(wallet),
  };
}

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function fakeServer() {
  const calls: Call[] = [];
  const state = { mode: "ok" as "ok" | "down" | "throws" };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.mode === "throws") throw new Error("network");
    const path = String(input).replace(SIM, "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (state.mode === "down") return new Response("{}", { status: 503 });
    const reply = path === "/v1/quests/challenge" ? { challenge: "abc123" } : { accepted: 1 };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { calls, state, fetchFn };
}

async function rig(wallet = WALLET_A) {
  const storage = memoryStorage();
  const keys = memoryKeys();
  const server = fakeServer();
  const clock = { now: START };
  const timers: { run: () => void; delayMs: number }[] = [];
  const queue = createQuestQueue({
    storage,
    keys,
    fetchFn: server.fetchFn,
    simUrl: SIM,
    now: () => clock.now,
    schedule: (run, delayMs) => void timers.push({ run, delayMs }),
  });
  return { storage, keys, server, clock, timers, queue, wallet };
}

async function turnOn(r: Awaited<ReturnType<typeof rig>>) {
  const { pair, deviceKey } = await generateDeviceKey();
  await r.keys.put(r.wallet, pair);
  saveDevice(r.storage, r.wallet, { deviceKey, untilMs: r.clock.now + 30 * DAY });
  return { pair, deviceKey };
}

const orderCalls = (calls: Call[]) => calls.filter((call) => call.path === "/v1/quests/orders");
const secretOf = (n: number) => n.toString(16).padStart(32, "0");

describe("signed texts", () => {
  it("match the contract byte for byte", () => {
    expect(consentText("W1", "D1", "2027-01-15T08:00:00.000Z", "c0de")).toBe(
      "Earn MagicBlock quest points on this device. While on, NoirWire records which of your trades count toward quests.\nWallet: W1\nDevice key: D1\nUntil: 2027-01-15T08:00:00.000Z\nCode: c0de",
    );
    expect(
      ordersText("D1", 1700000000000, [
        { market: "NSOL-PERP", secret: "00000000000000000000000000000001" },
        { market: "NBTC-PERP", secret: "00000000000000000000000000000002" },
      ]),
    ).toBe(
      "NoirWire quest orders\nD1\n1700000000000\nNSOL-PERP 00000000000000000000000000000001\nNBTC-PERP 00000000000000000000000000000002",
    );
    expect(revokeText("D1", 1700000000000)).toBe("NoirWire quest device off\nD1\n1700000000000");
  });
});

describe("opting in", () => {
  it("sends the wallet signature over the consent text and keeps a non-extractable device key", async () => {
    const r = await rig();
    const owner = Keypair.generate();
    const wallet = owner.publicKey.toBase58();
    const outcome = await enableQuests({
      storage: r.storage,
      keys: r.keys,
      fetchFn: r.server.fetchFn,
      simUrl: SIM,
      signer: keypairOwnerSigner(owner),
      now: () => r.clock.now,
    });
    expect(outcome).toBe("on");
    const sent = r.server.calls.find((call) => call.path === "/v1/quests/device")!.body;
    const until = new Date(r.clock.now + 30 * DAY).toISOString();
    expect(sent.until).toBe(until);
    const text = consentText(wallet, String(sent.deviceKey), until, "abc123");
    const signature = nacl.sign.detached.verify(
      new TextEncoder().encode(text),
      Uint8Array.from(fromBase58(String(sent.signature))),
      owner.publicKey.toBytes(),
    );
    expect(signature).toBe(true);
    const pair = await r.keys.get(wallet);
    expect(pair?.privateKey.extractable).toBe(false);
    expect(loadDevice(r.storage, wallet)?.deviceKey).toBe(sent.deviceKey);
    expect(questStatus(r.storage, wallet, r.clock.now)).toBe("on");
  });

  it("shows renewal inside the last three days and once past", async () => {
    const r = await rig();
    const { deviceKey } = await generateDeviceKey();
    saveDevice(r.storage, WALLET_A, { deviceKey, untilMs: r.clock.now + 2 * DAY });
    expect(questStatus(r.storage, WALLET_A, r.clock.now)).toBe("renew");
    expect(questStatus(r.storage, WALLET_A, r.clock.now + 3 * DAY)).toBe("renew");
  });
});

describe("the order queue", () => {
  it("queues and sends nothing while the switch is off", async () => {
    const r = await rig();
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A, true);
    expect(r.server.calls).toHaveLength(0);
    expect(r.storage.size()).toBe(0);
  });

  it("sends a batch signed by the device key", async () => {
    const r = await rig();
    const { pair, deviceKey } = await turnOn(r);
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A);
    const [call] = orderCalls(r.server.calls);
    expect(call.body.deviceKey).toBe(deviceKey);
    const text = ordersText(deviceKey, Number(call.body.signedAt), [
      { market: "NSOL-PERP", secret: secretOf(1) },
    ]);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      pair.publicKey,
      Uint8Array.from(fromBase58(String(call.body.signature))),
      new TextEncoder().encode(text),
    );
    expect(valid).toBe(true);
    expect(r.storage.getItem(ownerDataKeys.questQueue(WALLET_A))).toBeNull();
  });

  it("never lets the caller see a failure, whatever the server or storage does", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "throws";
    expect(() => r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1))).not.toThrow();
    await r.queue.flush(WALLET_A);
    const broken = createQuestQueue({
      storage: {
        getItem: () => {
          throw new Error("storage");
        },
        setItem: () => {
          throw new Error("storage");
        },
        removeItem: () => {},
      },
      keys: r.keys,
      fetchFn: r.server.fetchFn,
      simUrl: SIM,
    });
    expect(() => broken.enqueue(WALLET_A, "NSOL-PERP", secretOf(2))).not.toThrow();
  });

  it("flushes after the server comes back, on the backoff timer", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "down";
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A);
    expect(r.timers).toHaveLength(1);
    expect(orderCalls(r.server.calls)).toHaveLength(1);
    r.server.state.mode = "ok";
    r.clock.now += r.timers[0].delayMs;
    r.timers[0].run();
    await r.queue.flush(WALLET_A);
    expect(orderCalls(r.server.calls)).toHaveLength(2);
    expect(r.storage.getItem(ownerDataKeys.questQueue(WALLET_A))).toBeNull();
  });

  it("sends at most 20 orders per call", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "down";
    for (let n = 0; n < 45; n += 1) r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(n));
    await r.queue.flush(WALLET_A);
    r.server.calls.length = 0;
    r.server.state.mode = "ok";
    await r.queue.flush(WALLET_A, true);
    const sizes = orderCalls(r.server.calls).map((call) => (call.body.orders as unknown[]).length);
    expect(sizes).toEqual([20, 20, 5]);
  });

  it("drops orders older than ten minutes without sending them", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "down";
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A);
    r.server.calls.length = 0;
    r.server.state.mode = "ok";
    r.clock.now += QUEST_ORDER_MAX_AGE_MS + 1;
    await r.queue.flush(WALLET_A, true);
    expect(r.server.calls).toHaveLength(0);
  });

  it("stops sending once the device key has expired", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "down";
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A);
    r.server.calls.length = 0;
    r.server.state.mode = "ok";
    r.clock.now += 31 * DAY;
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(2));
    await r.queue.flush(WALLET_A, true);
    expect(r.server.calls).toHaveLength(0);
  });

  it("never sends one wallet's queue under another wallet's device", async () => {
    const r = await rig(WALLET_A);
    await turnOn(r);
    r.storage.setItem(
      ownerDataKeys.questQueue(WALLET_B),
      JSON.stringify([{ market: "NSOL-PERP", secretHex: secretOf(9), atMs: r.clock.now }]),
    );
    await r.queue.flush(WALLET_B, true);
    expect(r.server.calls).toHaveLength(0);
  });
});

describe("turning off and removing the wallet", () => {
  it("clears the key and queue, tells the server, and never flushes again", async () => {
    const r = await rig();
    const { pair, deviceKey } = await turnOn(r);
    r.server.state.mode = "down";
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(1));
    await r.queue.flush(WALLET_A);
    r.server.calls.length = 0;
    r.server.state.mode = "ok";
    const off = await disableQuests(
      {
        storage: r.storage,
        keys: r.keys,
        fetchFn: r.server.fetchFn,
        simUrl: SIM,
        now: () => r.clock.now,
      },
      WALLET_A,
    );
    await off.revoke;
    expect(r.storage.size()).toBe(0);
    expect(await r.keys.get(WALLET_A)).toBeUndefined();
    const revoke = r.server.calls.find((call) => call.path === "/v1/quests/device/revoke")!;
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      pair.publicKey,
      Uint8Array.from(fromBase58(String(revoke.body.signature))),
      new TextEncoder().encode(revokeText(deviceKey, Number(revoke.body.signedAt))),
    );
    expect(valid).toBe(true);
    r.queue.enqueue(WALLET_A, "NSOL-PERP", secretOf(2));
    await r.queue.flush(WALLET_A, true);
    expect(orderCalls(r.server.calls)).toHaveLength(0);
  });

  it("turns off even when the revoke call cannot be made", async () => {
    const r = await rig();
    await turnOn(r);
    r.server.state.mode = "throws";
    const off = await disableQuests(
      { storage: r.storage, keys: r.keys, fetchFn: r.server.fetchFn, simUrl: SIM },
      WALLET_A,
    );
    await off.revoke;
    expect(r.storage.size()).toBe(0);
  });

  it("removes the quest data when the wallet is cleared", async () => {
    const storage = memoryStorage();
    storage.setItem("noirwire-terminal-wallet-address", WALLET_A);
    storage.setItem(ownerDataKeys.questDevice(WALLET_A), "{}");
    storage.setItem(ownerDataKeys.questQueue(WALLET_A), "[]");
    clearWallet(storage);
    expect(storage.getItem(ownerDataKeys.questDevice(WALLET_A))).toBeNull();
    expect(storage.getItem(ownerDataKeys.questQueue(WALLET_A))).toBeNull();
  });
});

describe("quest dialog", () => {
  it("opens for a visitor who has not dismissed it unless quest points are on", () => {
    expect(shouldOpenQuestDialog({ dismissed: false, status: "off" })).toBe(true);
    expect(shouldOpenQuestDialog({ dismissed: false, status: "renew" })).toBe(true);
    expect(shouldOpenQuestDialog({ dismissed: false, status: "on" })).toBe(false);
  });

  it("stays closed once dismissed", () => {
    expect(shouldOpenQuestDialog({ dismissed: true, status: "off" })).toBe(false);
    expect(shouldOpenQuestDialog({ dismissed: true, status: "renew" })).toBe(false);
  });

  it("remembers a dismissal in this browser", () => {
    const storage = memoryStorage();
    expect(inviteDismissed(storage)).toBe(false);
    dismissInvite(storage);
    expect(inviteDismissed(storage)).toBe(true);
  });

  it("arriving from the quest board clears an earlier dismissal", () => {
    const storage = memoryStorage();
    dismissInvite(storage);
    recordInvite(storage, "?from=quests");
    expect(inviteDismissed(storage)).toBe(false);
  });

  it("keeps a dismissal for other arrivals", () => {
    const storage = memoryStorage();
    dismissInvite(storage);
    recordInvite(storage, "?from=elsewhere");
    recordInvite(storage, "");
    expect(inviteDismissed(storage)).toBe(true);
  });
});

function fromBase58(base58: string): number[] {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of base58) value = value * 58n + BigInt(alphabet.indexOf(char));
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  const zeros = base58.length - base58.replace(/^1+/, "").length;
  return [...new Array<number>(zeros).fill(0), ...bytes];
}
