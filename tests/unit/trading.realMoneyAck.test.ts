import { describe, expect, it } from "vitest";
import {
  acknowledgementKey,
  hasAcknowledged,
  needsAcknowledgement,
  REAL_MONEY_STATEMENTS,
  recordAcknowledgement,
} from "@/lib/trading/realMoneyAck";
import type { KeyValueStore } from "@/lib/wallet";

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("real-money acknowledgement", () => {
  it("is remembered per owner", () => {
    const storage = memoryStore();
    expect(hasAcknowledged(storage, "owner-a")).toBe(false);
    expect(recordAcknowledgement(storage, "owner-a")).toBe(true);
    expect(hasAcknowledged(storage, "owner-a")).toBe(true);
    expect(hasAcknowledged(storage, "owner-b")).toBe(false);
    expect(acknowledgementKey("owner-a")).not.toBe(acknowledgementKey("owner-b"));
  });

  it("asks again after the statements changed, because the old acceptance sits under the old key", () => {
    const storage = memoryStore();
    storage.setItem("noirwire-terminal-real-money-ack:owner-a", "1");
    expect(hasAcknowledged(storage, "owner-a")).toBe(false);
    expect(acknowledgementKey("owner-a")).toContain(":v2:");
  });

  it("states the liquidation and funding risk", () => {
    expect(REAL_MONEY_STATEMENTS.some((line) => line.includes("liquidated"))).toBe(true);
    expect(REAL_MONEY_STATEMENTS.some((line) => line.includes("funding"))).toBe(true);
  });

  it("asks the next owner after another one accepted, even when storage keeps nothing", () => {
    const forgetful: KeyValueStore = { ...memoryStore(), setItem: () => {} };
    expect(needsAcknowledgement(forgetful, "owner-a", null)).toBe(true);
    expect(needsAcknowledgement(forgetful, "owner-a", "owner-a")).toBe(false);
    expect(needsAcknowledgement(forgetful, "owner-b", "owner-a")).toBe(true);
  });

  it("asks an owner who never accepted although another did in storage", () => {
    const storage = memoryStore();
    recordAcknowledgement(storage, "owner-a");
    expect(needsAcknowledgement(storage, "owner-a", null)).toBe(false);
    expect(needsAcknowledgement(storage, "owner-b", "owner-a")).toBe(true);
  });

  it("is shown again when storage throws", () => {
    expect(hasAcknowledged(broken, "owner-a")).toBe(false);
    expect(recordAcknowledgement(broken, "owner-a")).toBe(false);
  });

  it("is shown again when storage accepts the write but does not keep it", () => {
    const forgetful: KeyValueStore = { ...memoryStore(), setItem: () => {} };
    expect(recordAcknowledgement(forgetful, "owner-a")).toBe(false);
    expect(hasAcknowledged(forgetful, "owner-a")).toBe(false);
  });

  it("is shown when there is no storage or no owner", () => {
    expect(hasAcknowledged(null, "owner-a")).toBe(false);
    expect(hasAcknowledged(memoryStore(), "")).toBe(false);
    expect(recordAcknowledgement(memoryStore(), "")).toBe(false);
  });
});
