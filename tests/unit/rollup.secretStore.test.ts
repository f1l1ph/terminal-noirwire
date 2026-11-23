import { describe, expect, it } from "vitest";
import {
  loadTrackedSecrets,
  trackSecret,
  unpinTriggerSecrets,
  type TrackedOrderSecret,
} from "@/lib/rollup/secretStore";
import { ownerDataKeys, type KeyValueStore } from "@/lib/wallet/index";

const OWNER = "owner-address";

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const secret = (n: number) => new Uint8Array(16).fill(n);

describe("tracked order secrets", () => {
  it("keeps only the newest unpinned secrets past the cap", () => {
    const storage = memory();
    for (let n = 1; n <= 25; n++) trackSecret(storage, OWNER, "NSOL-PERP", secret(n));
    const kept = loadTrackedSecrets(storage, OWNER);
    expect(kept).toHaveLength(20);
    expect(kept[0].secretHex).toBe("06".repeat(16));
  });

  it("never evicts a pinned trigger secret, however many orders follow", () => {
    const storage = memory();
    trackSecret(storage, OWNER, "NSOL-PERP", secret(200), "stopLoss");
    for (let n = 1; n <= 40; n++) trackSecret(storage, OWNER, "NSOL-PERP", secret(n));
    const kept = loadTrackedSecrets(storage, OWNER);
    expect(kept.find((entry) => entry.pinned)?.secretHex).toBe("c8".repeat(16));
    expect(kept.filter((entry) => !entry.pinned).length).toBeLessThanOrEqual(19);
    expect(kept).toHaveLength(20);
  });

  it("drops the oldest unpinned first and still leaves room for orders when many are pinned", () => {
    const storage = memory();
    for (let n = 1; n <= 22; n++) {
      trackSecret(storage, OWNER, `M${n}`, secret(n), n % 2 ? "takeProfit" : "stopLoss");
    }
    trackSecret(storage, OWNER, "ORDER", secret(99));
    const kept = loadTrackedSecrets(storage, OWNER);
    expect(kept.filter((entry) => entry.pinned)).toHaveLength(22);
    expect(kept.some((entry) => entry.market === "ORDER")).toBe(true);
  });

  it("unpins a trigger's secret, keeping the one that replaced it", () => {
    const storage = memory();
    trackSecret(storage, OWNER, "NSOL-PERP", secret(1), "takeProfit");
    trackSecret(storage, OWNER, "NSOL-PERP", secret(2), "takeProfit");
    trackSecret(storage, OWNER, "NSOL-PERP", secret(3), "stopLoss");
    unpinTriggerSecrets(storage, OWNER, "NSOL-PERP", "takeProfit", secret(2));
    const kept = loadTrackedSecrets(storage, OWNER);
    expect(kept.map((entry) => Boolean(entry.pinned))).toEqual([false, true, true]);
    expect(kept[0]).not.toHaveProperty("trigger");
    unpinTriggerSecrets(storage, OWNER, "NSOL-PERP", "stopLoss");
    expect(loadTrackedSecrets(storage, OWNER).filter((entry) => entry.pinned)).toHaveLength(1);
  });

  it("loads entries stored before pinning existed", () => {
    const storage = memory();
    const old: TrackedOrderSecret[] = [
      { market: "NSOL-PERP", secretHex: "01".repeat(16), placedAtMs: 1 },
    ];
    storage.setItem(ownerDataKeys.orderSecrets(OWNER), JSON.stringify(old));
    expect(loadTrackedSecrets(storage, OWNER)).toEqual(old);
    trackSecret(storage, OWNER, "NSOL-PERP", secret(2));
    expect(loadTrackedSecrets(storage, OWNER)).toHaveLength(2);
  });
});
