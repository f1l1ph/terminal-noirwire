import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveOrderKey } from "@noirwire/orderbook";
import { deviceOrderKeys, type DeviceKeyDeps, type DeviceSeeds } from "@/lib/rollup/orderKeySetup";
import { freshOrderKeys, type OrderKeyManager, type View } from "@/lib/rollup/sdk";

const OWNER = "OwnerAddress111111111111111111111111111111";
const NOW = 1_800_000_000_000;
const SEED = new Uint8Array(32).fill(7);

const viewOf = (orderKeys: PublicKey[], expiriesMs: number[] = []) =>
  ({
    orderKeys,
    snapshot: { orders: expiriesMs.map((ms) => ({ expiry: BigInt(Math.floor(ms / 1000)) })) },
  }) as unknown as View;

const keysOf = (seed: Uint8Array, indices: number[]) =>
  indices.map((index) => deriveOrderKey(seed, index).publicKey);

const strangersKeys = () => keysOf(new Uint8Array(32).fill(99), [0, 1, 2, 3]);

function setup(options: { stored?: Uint8Array | null; view: View | null; createFails?: boolean }) {
  const events: string[] = [];
  const seeds: DeviceSeeds = {
    load: async () => options.stored ?? null,
    create: async () => {
      if (options.createFails) throw new Error("browser storage is unavailable");
      events.push("seed created");
      return SEED;
    },
  };
  const installed: string[][] = [];
  const sleeps: number[] = [];
  const deps: DeviceKeyDeps = {
    ownerAddress: OWNER,
    seeds,
    checkpoint: null,
    readView: async () => options.view,
    install: async (keys: OrderKeyManager) => {
      events.push("set_order_keys");
      installed.push(keys.publicKeys.map((key) => key.toBase58()));
    },
    report: vi.fn(),
    now: () => NOW,
    sleep: async (ms) => {
      events.push("waited");
      sleeps.push(ms);
    },
  };
  return { deps, events, installed, sleeps };
}

describe("order keys on a new device", () => {
  it("waits for old orders to lapse, then installs this seed's keys with exactly one owner transaction", async () => {
    const { deps, events, installed, sleeps } = setup({ view: viewOf(strangersKeys()) });
    const keys = await deviceOrderKeys(deps);
    expect(events).toEqual(["seed created", "waited", "set_order_keys"]);
    expect(sleeps).toEqual([60_000]);
    expect(installed).toEqual([freshOrderKeys(SEED).publicKeys.map((key) => key.toBase58())]);
    expect(keys.publicKeys.map((key) => key.toBase58())).toEqual(installed[0]);
  });

  it("still waits the full 60 seconds when a resting order expires in 5", async () => {
    const view = viewOf(strangersKeys(), [NOW + 5_000]);
    const { deps, sleeps } = setup({ view });
    await deviceOrderKeys(deps);
    expect(sleeps).toEqual([60_000]);
  });

  it("tells the UI it is waiting, until when, and then that it is installing", async () => {
    const { deps } = setup({ view: viewOf(strangersKeys()) });
    await deviceOrderKeys(deps);
    expect(deps.report).toHaveBeenNthCalledWith(1, { stage: "settling", readyAtMs: NOW + 60_000 });
    expect(deps.report).toHaveBeenNthCalledWith(2, { stage: "installing" });
  });

  it("replaces keys another device installed, even when this device already has a seed", async () => {
    const { deps, installed, sleeps } = setup({ stored: SEED, view: viewOf(strangersKeys()) });
    await deviceOrderKeys(deps);
    expect(sleeps).toHaveLength(1);
    expect(installed).toHaveLength(1);
  });
});

describe("order keys on a device that has them", () => {
  it("keeps the keys this seed made, waiting for nothing and installing nothing", async () => {
    const inView = keysOf(SEED, [5, 1, 2, 7]);
    const { deps, events } = setup({ stored: SEED, view: viewOf(inView) });
    const keys = await deviceOrderKeys(deps);
    expect(events).toEqual([]);
    expect(keys.publicKeys.map((key) => key.toBase58())).toEqual(
      inView.map((key) => key.toBase58()),
    );
  });
});

describe("order keys before the account is opened", () => {
  it("starts from this seed's first four keys, waiting for nothing and installing nothing", async () => {
    const { deps, events } = setup({ view: null });
    const keys = await deviceOrderKeys(deps);
    expect(events).toEqual(["seed created"]);
    expect(keys.publicKeys.map((key) => key.toBase58())).toEqual(
      freshOrderKeys(SEED).publicKeys.map((key) => key.toBase58()),
    );
  });
});

describe("a seed that cannot be stored", () => {
  it("refuses to go on rather than use keys that would be lost on reload", async () => {
    const { deps, installed } = setup({ view: viewOf(strangersKeys()), createFails: true });
    await expect(deviceOrderKeys(deps)).rejects.toThrow(/storage/);
    expect(installed).toEqual([]);
  });
});
