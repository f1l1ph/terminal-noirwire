import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession } from "@/lib/rollup/session";
import type { WalletIdentity } from "@/lib/trading/types";

/**
 * A session build that fails once (for example because the deployment
 * fetch failed) is kept by the trading client as its session for that
 * wallet. withSession awaits it before its retry block, so the retry never
 * runs, and every later call rejects until the wallet is closed.
 */
describe("audit: session build failure", () => {
  it("a session build that failed once is retried on the next call", async () => {
    let builds = 0;
    const map = new Map<string, string>();
    const trading = new RollupTradingClient({
      simUrl: "http://sim.test",
      marketSettingsLookup: () => undefined,
      storage: {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
      },
      buildSession: async () => {
        builds += 1;
        if (builds === 1) throw new TypeError("network blip");
        return {
          owner: Keypair.generate(),
          orderKeyPublicKeys: [],
          client: {
            view: async () => {
              throw new Error("no view");
            },
            subscribeView: () => async () => {},
          },
          deployment: { markets: [] },
          tokenIndexBySymbol: new Map(),
          createdAtMs: Date.now(),
          saveKeyCheckpoint: () => {},
          close: () => {},
        } as unknown as RollupSession;
      },
    });
    const wallet: WalletIdentity = { address: "owner", secretKeyHex: "aa".repeat(64) };

    await trading.fetchState(wallet).catch(() => null);
    const second = await trading.fetchState(wallet).then(
      () => "ok",
      (error: unknown) => `still failing: ${(error as Error).message}`,
    );
    expect({ second, builds }).toEqual({ second: "ok", builds: 2 });
  });
});
