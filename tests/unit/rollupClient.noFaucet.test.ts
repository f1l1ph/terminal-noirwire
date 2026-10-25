import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { KeyValueStore } from "@/lib/wallet/index";
import type { WalletIdentity } from "@/lib/trading/types";

const NO_FAUCET_REASON = "this deployment has no faucet: test funds are not handed out here";

const DEPLOYMENT: PublicDeployment = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
};

function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

function throwingStore(): KeyValueStore {
  const fail = () => {
    throw new Error("storage is blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function unopenedSession(): RollupSession {
  const client = {
    view: async () => {
      throw new Error("the view is not readable by this connection");
    },
    subscribeView: () => async () => {},
  } as unknown as TraderClientLike;
  return {
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map(),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  };
}

function noFaucetService() {
  return vi.fn(
    async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({ error: NO_FAUCET_REASON }),
      }) as Response,
  );
}

function clientWith(storage: KeyValueStore, fetchFn: typeof fetch, programId?: string) {
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    overrides: { programId },
    marketSettingsLookup: () => undefined,
    storage,
    fetchFn,
    buildSession: async () => unopenedSession(),
  });
}

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

describe("RollupTradingClient: a deployment with no faucet is remembered", () => {
  it("asks the service once, then answers noFaucet without asking again, across a reload", async () => {
    const storage = memoryStore();
    const fetchFn = noFaucetService();
    const first = clientWith(storage, fetchFn as unknown as typeof fetch);

    expect(await first.knownNoFaucet()).toBe(false);
    expect(await first.fund(WALLET)).toEqual({ kind: "noFaucet" });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    expect(await first.fund(WALLET)).toEqual({ kind: "noFaucet" });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const reloaded = clientWith(storage, fetchFn as unknown as typeof fetch);
    expect(await reloaded.knownNoFaucet()).toBe(true);
    expect(await reloaded.fund(WALLET)).toEqual({ kind: "noFaucet" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps the fact to its own deployment: another program is still asked", async () => {
    const storage = memoryStore();
    const fetchFn = noFaucetService();
    await clientWith(storage, fetchFn as unknown as typeof fetch).fund(WALLET);

    const other = clientWith(
      storage,
      fetchFn as unknown as typeof fetch,
      Keypair.generate().publicKey.toBase58(),
    );
    expect(await other.knownNoFaucet()).toBe(false);
  });

  it("still works when storage throws: it simply asks the service each time", async () => {
    const fetchFn = noFaucetService();
    const client = clientWith(throwingStore(), fetchFn as unknown as typeof fetch);

    expect(await client.knownNoFaucet()).toBe(false);
    expect(await client.fund(WALLET)).toEqual({ kind: "noFaucet" });
    expect(await client.fund(WALLET)).toEqual({ kind: "noFaucet" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
