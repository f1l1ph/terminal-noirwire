import { describe, expect, it } from "vitest";
import { deriveRollupOwnFills } from "@/lib/rollup/ownFills";
import { fillReceipt } from "@/lib/rollup/sdk";
import { loadTrackedSecrets, trackedSecretBytes, trackSecret } from "@/lib/rollup/secretStore";
import type { PublicFill } from "@/lib/market-data/types";
import type { KeyValueStore } from "@/lib/wallet/index";

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function bigEndianU64String(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  return value.toString();
}

function fillAt(secret: Uint8Array, fillSeq: bigint, over: Partial<PublicFill> = {}): PublicFill {
  return {
    market: "NSOL-PERP",
    price: "150.000000",
    size: "1.000000",
    takerSide: "buy",
    takerTag: bigEndianU64String(fillReceipt(secret, fillSeq, "taker")),
    makerTag: bigEndianU64String(fillReceipt(secret, fillSeq, "maker")),
    timestampMs: 1_000,
    sequence: Number(fillSeq),
    ...over,
  };
}

describe("deriveRollupOwnFills: receipt-based own-fill recognition", () => {
  it("recognises a taker fill from its own secret and not from an unrelated one", () => {
    const mine = new Uint8Array(16).fill(7);
    const stranger = new Uint8Array(16).fill(9);
    const fill = fillAt(mine, 42n);
    expect(deriveRollupOwnFills([fill], [mine])).toHaveLength(1);
    expect(deriveRollupOwnFills([fill], [stranger])).toHaveLength(0);
  });

  it("never matches two different fill sequences against the same secret's tag from a different sequence", () => {
    const mine = new Uint8Array(16).fill(3);
    const fillOne = fillAt(mine, 1n);
    // A fill at a different sequence carries an unrelated receipt (RULES.md
    // section 10: "two fills of the same order carry unrelated receipts").
    const fillTwo: PublicFill = {
      ...fillAt(mine, 2n),
      takerTag: fillOne.takerTag,
      makerTag: fillOne.makerTag,
    };
    expect(deriveRollupOwnFills([fillTwo], [mine])).toHaveLength(0);
  });

  it("recognises a maker-side fill with the correct side (the opposite of the taker's)", () => {
    const mine = new Uint8Array(16).fill(5);
    const fill: PublicFill = {
      ...fillAt(new Uint8Array(16).fill(1), 10n), // taker is someone else
      makerTag: bigEndianU64String(fillReceipt(mine, 10n, "maker")),
      takerSide: "buy",
    };
    const [own] = deriveRollupOwnFills([fill], [mine]);
    expect(own.role).toBe("maker");
    expect(own.side).toBe("sell"); // opposite of the taker's buy
  });
});

describe("Own-fill recognition surviving a reload", () => {
  it("persists a placed order's secret so a fresh store load still recognises its fill", () => {
    const storeBeforeReload = memoryStore();
    const owner = "OwnerAddress111111111111111111111111111111";
    const secret = new Uint8Array(16).fill(11);
    trackSecret(storeBeforeReload, owner, "NSOL-PERP", secret);

    // Simulate a reload: a brand new KeyValueStore instance backed by the
    // same persisted string (what localStorage would hand back after the
    // page reopens), not the same in-memory object.
    const persisted = (
      storeBeforeReload as unknown as { getItem(k: string): string | null }
    ).getItem(`noirwire-terminal-rollup-secrets-${owner}`)!;
    const storeAfterReload = memoryStore();
    storeAfterReload.setItem(`noirwire-terminal-rollup-secrets-${owner}`, persisted);

    const entries = loadTrackedSecrets(storeAfterReload, owner);
    const secrets = trackedSecretBytes(entries);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toEqual(secret);

    const fill = fillAt(secret, 99n);
    expect(deriveRollupOwnFills([fill], secrets)).toHaveLength(1);
  });

  it("caps tracked secrets at the most recent 20, evicting the oldest", () => {
    const store = memoryStore();
    const owner = "OwnerAddress222222222222222222222222222222";
    const secrets: Uint8Array[] = [];
    for (let i = 0; i < 25; i += 1) {
      const secret = new Uint8Array(16).fill(i + 1);
      secrets.push(secret);
      trackSecret(store, owner, "NSOL-PERP", secret);
    }
    const entries = loadTrackedSecrets(store, owner);
    expect(entries).toHaveLength(20);
    // The oldest 5 were evicted; the most recent (last placed) survived.
    const kept = trackedSecretBytes(entries);
    expect(kept.some((bytes) => bytes.every((b, i) => b === secrets[24][i]))).toBe(true);
    expect(kept.some((bytes) => bytes.every((b, i) => b === secrets[0][i]))).toBe(false);
  });
});
