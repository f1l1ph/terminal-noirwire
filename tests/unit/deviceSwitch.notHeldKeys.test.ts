import { describe, expect, it, vi } from "vitest";
import { deviceOrderKeys, type DeviceKeyDeps } from "@/lib/rollup/orderKeySetup";
import type { View } from "@/lib/rollup/sdk";
import { keysOf, SEED, STRANGER_SEED } from "./support/rollupFixtures";

// The full search for keys this seed never made takes many seconds; the search
// is replaced by its own "not from this seed" answer, which is all it gives here.
vi.mock("@/lib/rollup/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rollup/sdk")>();
  return {
    ...actual,
    orderKeysFromCheckpoint: () => {
      throw new Error(actual.KEYS_NOT_FROM_SEED_MESSAGE);
    },
  };
});

const foreignView = () =>
  ({
    orderKeys: keysOf(STRANGER_SEED, [0, 1, 2, 3]),
    seatRecorded: true,
  }) as unknown as View;

function depsWith(checkpoint: DeviceKeyDeps["checkpoint"]): DeviceKeyDeps {
  return {
    ownerAddress: "owner",
    seeds: { load: async () => SEED, create: async () => SEED },
    checkpoint,
    readView: async () => foreignView(),
    report: vi.fn(),
  };
}

describe("the keys of a session that does not hold the account's", () => {
  it("start past the device's saved checkpoint, so a move installs where resync reaches", async () => {
    const { keys, held } = await deviceOrderKeys(
      depsWith({ indices: [96, 97, 98, 99], nextIndex: 100 }),
    );
    expect(held).toBe(false);
    expect(keys.checkpoint.nextIndex).toBe(104);
  });

  it("start from the first four keys on a device with no checkpoint", async () => {
    const { keys, held } = await deviceOrderKeys(depsWith(null));
    expect(held).toBe(false);
    expect(keys.checkpoint.nextIndex).toBe(4);
  });
});
