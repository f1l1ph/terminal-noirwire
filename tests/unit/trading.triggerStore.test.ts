import { describe, expect, it } from "vitest";
import {
  clearLocalTrigger,
  loadTriggerBook,
  setLocalTrigger,
  splitTriggerBook,
  staleTriggerKinds,
  type LocalTrigger,
} from "@/lib/trading/triggerStore";
import { ownerDataKeys, clearWallet, type KeyValueStore } from "@/lib/wallet/index";
import type { TriggerStatuses } from "@/lib/trading/types";

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const OWNER = "owner-address";
const MARKET = "NSOL-PERP";
const trigger = (overrides: Partial<LocalTrigger> = {}): LocalTrigger => ({
  price: "160.00",
  size: null,
  slippageBps: 100,
  long: true,
  setAtMs: 1_000,
  ...overrides,
});
const statuses = (
  takeProfit: TriggerStatuses["takeProfit"]["state"],
  stopLoss: TriggerStatuses["stopLoss"]["state"],
  readAtMs: number,
): TriggerStatuses => ({
  takeProfit: { state: takeProfit },
  stopLoss: { state: stopLoss },
  readAtMs,
});

describe("the trigger prices this device remembers", () => {
  it("starts empty", () => {
    expect(loadTriggerBook(memoryStore(), OWNER)).toEqual({});
  });

  it("keeps a price per wallet, market and kind", () => {
    const store = memoryStore();
    setLocalTrigger(store, OWNER, MARKET, "takeProfit", trigger());
    setLocalTrigger(store, OWNER, MARKET, "stopLoss", trigger({ price: "140.00" }));
    setLocalTrigger(store, "someone-else", MARKET, "stopLoss", trigger({ price: "1.00" }));
    const book = loadTriggerBook(store, OWNER);
    expect(book[MARKET].takeProfit?.price).toBe("160.00");
    expect(book[MARKET].stopLoss?.price).toBe("140.00");
    expect(loadTriggerBook(store, "someone-else")[MARKET].takeProfit).toBeUndefined();
  });

  it("replaces a price set again", () => {
    const store = memoryStore();
    setLocalTrigger(store, OWNER, MARKET, "takeProfit", trigger());
    setLocalTrigger(store, OWNER, MARKET, "takeProfit", trigger({ price: "170.00" }));
    expect(loadTriggerBook(store, OWNER)[MARKET].takeProfit?.price).toBe("170.00");
  });

  it("forgets one kind, then the whole record", () => {
    const store = memoryStore();
    setLocalTrigger(store, OWNER, MARKET, "takeProfit", trigger());
    setLocalTrigger(store, OWNER, MARKET, "stopLoss", trigger({ price: "140.00" }));
    clearLocalTrigger(store, OWNER, MARKET, "takeProfit");
    expect(loadTriggerBook(store, OWNER)[MARKET]).toEqual({
      stopLoss: trigger({ price: "140.00" }),
    });
    clearLocalTrigger(store, OWNER, MARKET, "stopLoss");
    expect(loadTriggerBook(store, OWNER)).toEqual({});
    expect(store.getItem(ownerDataKeys.triggerPrices(OWNER))).toBeNull();
  });

  it("ignores a record that is not shaped like one", () => {
    const store = memoryStore();
    store.setItem(ownerDataKeys.triggerPrices(OWNER), "{not json");
    expect(loadTriggerBook(store, OWNER)).toEqual({});
    store.setItem(
      ownerDataKeys.triggerPrices(OWNER),
      JSON.stringify({ [MARKET]: { takeProfit: { price: 5 }, stopLoss: trigger() } }),
    );
    expect(loadTriggerBook(store, OWNER)).toEqual({ [MARKET]: { stopLoss: trigger() } });
  });

  it("is wiped with the wallet", () => {
    const store = memoryStore();
    store.setItem("noirwire-terminal-wallet-address", OWNER);
    setLocalTrigger(store, OWNER, MARKET, "takeProfit", trigger());
    clearWallet(store);
    expect(store.getItem(ownerDataKeys.triggerPrices(OWNER))).toBeNull();
  });
});

describe("a remembered price the exchange has contradicted", () => {
  it("is dropped once a read taken after it was set reports it gone", () => {
    const local = { takeProfit: trigger({ setAtMs: 1_000 }) };
    expect(staleTriggerKinds(local, statuses("gone", "gone", 2_000), true)).toEqual(["takeProfit"]);
  });

  it("is kept while the exchange reports it live", () => {
    const local = { takeProfit: trigger() };
    expect(staleTriggerKinds(local, statuses("armed", "gone", 2_000), true)).toEqual([]);
  });

  it("is kept when the report is older than the price, or not read yet", () => {
    const local = { takeProfit: trigger({ setAtMs: 3_000 }) };
    expect(staleTriggerKinds(local, statuses("gone", "gone", 2_000), true)).toEqual([]);
    expect(staleTriggerKinds(local, null, true)).toEqual([]);
  });

  it("is dropped when the position is now on the other side", () => {
    expect(staleTriggerKinds({ stopLoss: trigger({ long: true }) }, null, false)).toEqual([
      "stopLoss",
    ]);
  });
});

describe("splitting the book into what stands and what to forget", () => {
  const book = {
    [MARKET]: { takeProfit: trigger(), stopLoss: trigger({ price: "140.00" }) },
    "NETH-PERP": { takeProfit: trigger({ price: "9.00" }) },
  };

  it("forgets every price of a market whose position closed", () => {
    const { standing, forgotten } = splitTriggerBook(
      book,
      { [MARKET]: { size: "2.5" } },
      { [MARKET]: statuses("armed", "armed", 2_000) },
    );
    expect(Object.keys(standing)).toEqual([MARKET]);
    expect(forgotten).toEqual([{ market: "NETH-PERP", kinds: ["takeProfit"] }]);
  });

  it("forgets a price reported gone and keeps its sibling", () => {
    const { standing, forgotten } = splitTriggerBook(
      book,
      { [MARKET]: { size: "2.5" }, "NETH-PERP": { size: "1" } },
      { [MARKET]: statuses("armed", "gone", 2_000), "NETH-PERP": statuses("armed", "gone", 2_000) },
    );
    expect(standing[MARKET]).toEqual({ takeProfit: trigger() });
    expect(forgotten).toEqual([{ market: MARKET, kinds: ["stopLoss"] }]);
  });

  it("treats a zero size as no position", () => {
    const { standing } = splitTriggerBook(book, { [MARKET]: { size: "0" } }, {});
    expect(standing).toEqual({});
  });
});
