import { describe, expect, it } from "vitest";
import { z } from "zod";
import { keepLastKnown, loadLastKnown } from "@/lib/lastKnown";
import { loadMarketList, settingsOnly } from "@/lib/market-data/marketList";
import { MarketDataStore } from "@/lib/market-data/store";
import { fetchDeployment, type PublicDeployment } from "@/lib/rollup/deployment";
import { marketsResponseSchema, type MarketInfo } from "@/lib/sim-api/schema";
import type { KeyValueStore } from "@/lib/wallet";

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
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

const noWait = async () => {};

const MARKET: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 1.5,
  volume24h: "1234.000000",
  openInterest: "99.000000",
};

const SIM = "https://sim-one.example";
const OTHER_SIM = "https://sim-two.example";

describe("last known copy", () => {
  const schema = z.object({ n: z.number() });

  it("round trips what was kept", () => {
    const storage = memoryStore();
    expect(keepLastKnown(storage, "thing", SIM, { n: 3 })).toBe(true);
    expect(loadLastKnown(storage, "thing", SIM, schema)).toEqual({ n: 3 });
  });

  it("keeps one copy per service address", () => {
    const storage = memoryStore();
    keepLastKnown(storage, "thing", SIM, { n: 1 });
    expect(loadLastKnown(storage, "thing", OTHER_SIM, schema)).toBeNull();
    keepLastKnown(storage, "thing", OTHER_SIM, { n: 2 });
    expect(loadLastKnown(storage, "thing", SIM, schema)).toEqual({ n: 1 });
  });

  it("discards a copy that no longer fits the schema", () => {
    const storage = memoryStore();
    keepLastKnown(storage, "thing", SIM, { n: "three" });
    expect(loadLastKnown(storage, "thing", SIM, schema)).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("discards a copy that is not JSON", () => {
    const storage = memoryStore();
    keepLastKnown(storage, "thing", SIM, { n: 1 });
    const [key] = [...storage.map.keys()];
    storage.map.set(key, "{not json");
    expect(loadLastKnown(storage, "thing", SIM, schema)).toBeNull();
  });

  it("reads as nothing kept, never as an error, when storage throws", () => {
    expect(keepLastKnown(broken, "thing", SIM, { n: 1 })).toBe(false);
    expect(loadLastKnown(broken, "thing", SIM, schema)).toBeNull();
  });
});

describe("market list", () => {
  function options(
    store: MarketDataStore,
    storage: KeyValueStore,
    fetchMarkets: (url: string) => Promise<MarketInfo[]>,
    simUrl = SIM,
  ) {
    return { store, simUrl, storage, fetchMarkets, isCancelled: () => false, sleep: noWait };
  }

  it("keeps the live list without prices and uses it as is", async () => {
    const storage = memoryStore();
    const store = new MarketDataStore();
    await loadMarketList(options(store, storage, async () => [MARKET]));
    expect(store.getState().markets).toEqual([MARKET]);
    expect(store.getState().marketsFromKept).toBe(false);
    const [kept] = [...storage.map.values()];
    const parsed = marketsResponseSchema.shape.markets.parse(JSON.parse(kept));
    expect(parsed).toEqual(settingsOnly([MARKET]));
    expect(parsed[0].markPrice).toBeNull();
    expect(parsed[0].markPriceUpdatedAtMs).toBeNull();
  });

  it("does not touch the kept list while the live fetch works", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "markets", SIM, settingsOnly([{ ...MARKET, id: "OLD-PERP" }]));
    const store = new MarketDataStore();
    let sawKept = false;
    store.subscribe(() => {
      if (store.getState().marketsFromKept) sawKept = true;
    });
    await loadMarketList(options(store, storage, async () => [MARKET]));
    expect(sawKept).toBe(false);
    expect(store.getState().markets[0].id).toBe("NSOL-PERP");
  });

  it("falls back to the kept list when the live fetch fails, with no mark", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "markets", SIM, settingsOnly([MARKET]));
    const down = new MarketDataStore();
    let sawKept: MarketInfo[] | null = null;
    down.subscribe(() => {
      if (down.getState().marketsFromKept) sawKept = down.getState().markets;
    });
    let attempts = 0;
    await loadMarketList({
      ...options(down, storage, async () => {
        attempts += 1;
        throw new Error("down");
      }),
      isCancelled: () => attempts >= 2,
    });
    expect(sawKept).not.toBeNull();
    expect(sawKept![0].id).toBe("NSOL-PERP");
    expect(sawKept![0].markPrice).toBeNull();
    expect(down.getState().marketsUnreachable).toBe(true);
    expect(down.getState().marksByMarket).toEqual({});
  });

  it("replaces the kept list on screen and in storage when the live one arrives", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "markets", SIM, settingsOnly([{ ...MARKET, maxLeverage: 5 }]));
    const store = new MarketDataStore();
    let calls = 0;
    await loadMarketList(
      options(store, storage, async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return [MARKET];
      }),
    );
    expect(store.getState().marketsFromKept).toBe(false);
    expect(store.getState().marketsUnreachable).toBe(false);
    expect(store.getState().markets[0].maxLeverage).toBe(10);
    const [kept] = [...storage.map.values()];
    expect(JSON.parse(kept)[0].maxLeverage).toBe(10);
  });

  it("ignores an invalid kept list and stays unreachable", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "markets", SIM, [{ id: 7 }]);
    const store = new MarketDataStore();
    let attempts = 0;
    await loadMarketList({
      ...options(store, storage, async () => {
        attempts += 1;
        throw new Error("down");
      }),
      isCancelled: () => attempts >= 2,
    });
    expect(store.getState().markets).toEqual([]);
    expect(store.getState().marketsUnreachable).toBe(true);
    expect(store.getState().marketsFromKept).toBe(false);
  });

  it("works when storage throws", async () => {
    const store = new MarketDataStore();
    await loadMarketList(options(store, broken, async () => [MARKET]));
    expect(store.getState().markets).toEqual([MARKET]);

    const down = new MarketDataStore();
    let attempts = 0;
    await loadMarketList({
      ...options(down, broken, async () => {
        attempts += 1;
        throw new Error("down");
      }),
      isCancelled: () => attempts >= 2,
    });
    expect(down.getState().markets).toEqual([]);
    expect(down.getState().marketsUnreachable).toBe(true);
  });
});

function deployment(network: string): PublicDeployment {
  return {
    network,
    programId: "Prog1111111111111111111111111111111111111111",
    solanaRpcUrl: "http://127.0.0.1:8899",
    rollupRpcUrl: "http://127.0.0.1:6699",
    rollupWsUrl: "ws://127.0.0.1:6700",
    exchange: "Exch1111111111111111111111111111111111111111",
    stats: "Stat1111111111111111111111111111111111111111",
    markets: [],
  };
}

const answering = (body: PublicDeployment) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
const failing = (status?: number) =>
  (async () => {
    if (status === undefined) throw new TypeError("offline");
    return new Response("no", { status });
  }) as typeof fetch;

describe("deployment description", () => {
  it("is kept per service address after a live answer", async () => {
    const storage = memoryStore();
    await fetchDeployment(
      "https://dep-keep.example",
      {},
      answering(deployment("devnet")),
      noWait,
      storage,
    );
    expect(storage.map.size).toBe(1);
    expect([...storage.map.keys()][0]).toContain("https://dep-keep.example");
    expect(
      loadLastKnown(storage, "deployment", "https://dep-other.example", z.unknown()),
    ).toBeNull();
  });

  it("uses the kept description only when the service stays unreachable or busy", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "deployment", "https://dep-down.example", deployment("devnet"));
    for (const [index, status] of [undefined, 503].entries()) {
      const described = await fetchDeployment(
        `https://dep-down.example`,
        {},
        failing(status),
        noWait,
        storage,
      );
      expect(described.network, `case ${index}`).toBe("devnet");
    }
  });

  it("does not cover over a refusal or a malformed answer", async () => {
    const storage = memoryStore();
    keepLastKnown(storage, "deployment", "https://dep-404.example", deployment("devnet"));
    await expect(
      fetchDeployment("https://dep-404.example", {}, failing(404), noWait, storage),
    ).rejects.toThrow(/answered 404/);
    const garbage = (async () => new Response('{"nope":1}', { status: 200 })) as typeof fetch;
    await expect(
      fetchDeployment("https://dep-404.example", {}, garbage, noWait, storage),
    ).rejects.toThrow();
  });

  it("fails as before when nothing is kept or the kept copy is invalid", async () => {
    const storage = memoryStore();
    await expect(
      fetchDeployment("https://dep-none.example", {}, failing(503), noWait, storage),
    ).rejects.toThrow(/answered 503/);
    keepLastKnown(storage, "deployment", "https://dep-bad.example", { network: "devnet" });
    await expect(
      fetchDeployment("https://dep-bad.example", {}, failing(503), noWait, storage),
    ).rejects.toThrow(/answered 503/);
    expect(storage.map.size).toBe(0);
  });

  it("fails as before when storage throws", async () => {
    await expect(
      fetchDeployment("https://dep-broken.example", {}, failing(503), noWait, broken),
    ).rejects.toThrow(/answered 503/);
    const live = await fetchDeployment(
      "https://dep-broken-ok.example",
      {},
      answering(deployment("devnet")),
      noWait,
      broken,
    );
    expect(live.network).toBe("devnet");
  });

  it("asks the service again after a kept answer, and the live one replaces it", async () => {
    const storage = memoryStore();
    const url = "https://dep-replace.example";
    keepLastKnown(storage, "deployment", url, deployment("old-net"));
    const first = await fetchDeployment(url, {}, failing(503), noWait, storage);
    expect(first.network).toBe("old-net");
    const second = await fetchDeployment(
      url,
      {},
      answering(deployment("new-net")),
      noWait,
      storage,
    );
    expect(second.network).toBe("new-net");
    const stored = loadLastKnown(storage, "deployment", url, z.object({ network: z.string() }));
    expect(stored?.network).toBe("new-net");
    const third = await fetchDeployment(url, {}, failing(503), noWait, storage);
    expect(third.network).toBe("new-net");
  });

  it("still applies the overrides to a kept description", async () => {
    const storage = memoryStore();
    const url = "https://dep-override.example";
    keepLastKnown(storage, "deployment", url, deployment("devnet"));
    const described = await fetchDeployment(
      url,
      { rollupRpcUrl: "http://override.example" },
      failing(503),
      noWait,
      storage,
    );
    expect(described.rollupRpcUrl).toBe("http://override.example");
  });
});
