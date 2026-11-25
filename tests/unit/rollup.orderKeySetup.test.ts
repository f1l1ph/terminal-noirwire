import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveOrderKey } from "@noirwire/orderbook";
import {
  cancelsStops,
  deviceOrderKeys,
  type DeviceKeyDeps,
  type DeviceSeeds,
} from "@/lib/rollup/orderKeySetup";
import { freshOrderKeys, type View } from "@/lib/rollup/sdk";

const OWNER = "OwnerAddress111111111111111111111111111111";
const SEED = new Uint8Array(32).fill(7);

const viewOf = (orderKeys: PublicKey[], base = 0n, seatRecorded = true) =>
  ({
    orderKeys,
    seatRecorded,
    snapshot: { seat: { positions: [{ marketId: 0, base }] } },
  }) as unknown as View;

const keysOf = (seed: Uint8Array, indices: number[]) =>
  indices.map((index) => deriveOrderKey(seed, index).publicKey);

const strangersKeys = () => keysOf(new Uint8Array(32).fill(99), [0, 1, 2, 3]);

const base58 = (keys: PublicKey[]) => keys.map((key) => key.toBase58());

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
  const deps: DeviceKeyDeps = {
    ownerAddress: OWNER,
    seeds,
    checkpoint: null,
    readView: async () => options.view,
    report: vi.fn((status) => void events.push(`report ${status.stage}`)),
  };
  return { deps, events };
}

const reports = (deps: DeviceKeyDeps) =>
  (deps.report as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);

describe("order keys on a new device", () => {
  it("reports elsewhere and returns a fresh set that is not held, with nothing installed and no wait", async () => {
    const { deps, events } = setup({ view: viewOf(strangersKeys()) });
    const { keys, held } = await deviceOrderKeys(deps);
    expect(held).toBe(false);
    expect(reports(deps)).toEqual([{ stage: "elsewhere", cancelsStops: true }]);
    expect(events).toEqual(["seed created", "report elsewhere"]);
    expect(base58(keys.publicKeys)).toEqual(base58(freshOrderKeys(SEED).publicKeys));
  });

  it("warns that stops may be cancelled whenever the view records a seat, even with a flat snapshot", async () => {
    const { deps } = setup({ view: viewOf(strangersKeys(), 0n) });
    await deviceOrderKeys(deps);
    expect(reports(deps)[0]).toEqual({ stage: "elsewhere", cancelsStops: true });
  });

  it("does not warn when the view records no seat", async () => {
    const { deps } = setup({ view: viewOf(strangersKeys(), 5n, false) });
    await deviceOrderKeys(deps);
    expect(reports(deps)[0]).toEqual({ stage: "elsewhere", cancelsStops: false });
  });

  it("is elsewhere even when this device already has a seed whose keys are not the view's", async () => {
    const { deps } = setup({ stored: SEED, view: viewOf(strangersKeys()) });
    const { held } = await deviceOrderKeys(deps);
    expect(held).toBe(false);
    expect(reports(deps).map((status) => status.stage)).toEqual(["elsewhere"]);
  });

  it("reports a plain failed stage, and still rejects, when the view cannot be read, without leaking the error text", async () => {
    const { deps } = setup({ view: null });
    deps.readView = async () => {
      throw new Error("fetch failed for https://x/?token=secret");
    };
    await expect(deviceOrderKeys(deps)).rejects.toThrow();
    const last = reports(deps).at(-1);
    expect(last.stage).toBe("failed");
    expect(last.reason).not.toMatch(/secret|fetch/);
  });
});

describe("whether moving trading may cancel stops", () => {
  it("is true with a recorded seat, whatever the snapshot shows", () => {
    expect(cancelsStops(viewOf([], 3n))).toBe(true);
    expect(cancelsStops(viewOf([], -3n))).toBe(true);
    expect(cancelsStops(viewOf([], 0n))).toBe(true);
  });

  it("is false when the view records no seat", () => {
    expect(cancelsStops(viewOf([], 3n, false))).toBe(false);
  });
});

describe("order keys on a device that has them", () => {
  it("keeps the keys this seed made, held, reporting nothing", async () => {
    const inView = keysOf(SEED, [5, 1, 2, 7]);
    const { deps, events } = setup({ stored: SEED, view: viewOf(inView) });
    const { keys, held } = await deviceOrderKeys(deps);
    expect(held).toBe(true);
    expect(events).toEqual([]);
    expect(reports(deps)).toEqual([]);
    expect(base58(keys.publicKeys)).toEqual(base58(inView));
  });
});

describe("order keys before the account is opened", () => {
  it("starts from this seed's first four keys, held, waiting for nothing", async () => {
    const { deps, events } = setup({ view: null });
    const { keys, held } = await deviceOrderKeys(deps);
    expect(held).toBe(true);
    expect(events).toEqual(["seed created"]);
    expect(base58(keys.publicKeys)).toEqual(base58(freshOrderKeys(SEED).publicKeys));
  });
});

describe("a seed that cannot be stored", () => {
  it("refuses to go on rather than use keys that would be lost on reload", async () => {
    const { deps } = setup({ view: viewOf(strangersKeys()), createFails: true });
    await expect(deviceOrderKeys(deps)).rejects.toThrow(/storage/);
    expect(reports(deps).at(-1)).toMatchObject({ stage: "failed" });
  });

  it("reports the failure as key storage, whatever the store threw", async () => {
    const { deps } = setup({ view: viewOf(strangersKeys()) });
    deps.seeds.load = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    await expect(deviceOrderKeys(deps)).rejects.toThrow("aborted");
    expect(reports(deps).at(-1).failure).toBe("key_storage_unavailable");
  });
});
