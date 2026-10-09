import { describe, expect, it } from "vitest";
import { loadCheckpoint, saveCheckpoint } from "@/lib/rollup/checkpointStore";
import type { KeyValueStore } from "@/lib/wallet/index";

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("order-key checkpoint persistence (0.3.0's OrderKeyManager.checkpoint/restore)", () => {
  it("round-trips a checkpoint for an owner address", () => {
    const store = memoryStore();
    const owner = "OwnerAddress333333333333333333333333333333";
    expect(loadCheckpoint(store, owner)).toBeNull();

    saveCheckpoint(store, owner, { indices: [0, 1, 2, 3], nextIndex: 4 });
    expect(loadCheckpoint(store, owner)).toEqual({ indices: [0, 1, 2, 3], nextIndex: 4 });

    // A later call (after a key swap) overwrites, not appends.
    saveCheckpoint(store, owner, { indices: [0, 1, 2, 5], nextIndex: 6 });
    expect(loadCheckpoint(store, owner)).toEqual({ indices: [0, 1, 2, 5], nextIndex: 6 });
  });

  it("keeps different owners' checkpoints separate", () => {
    const store = memoryStore();
    saveCheckpoint(store, "owner-a", { indices: [0, 1, 2, 3], nextIndex: 4 });
    saveCheckpoint(store, "owner-b", { indices: [10, 11, 12, 13], nextIndex: 14 });
    expect(loadCheckpoint(store, "owner-a")?.nextIndex).toBe(4);
    expect(loadCheckpoint(store, "owner-b")?.nextIndex).toBe(14);
  });

  it("returns null for malformed stored data rather than throwing", () => {
    const store = memoryStore();
    store.setItem("noirwire-terminal-rollup-checkpoint-owner-c", "not json");
    expect(loadCheckpoint(store, "owner-c")).toBeNull();
  });
});
