import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveOrderKey } from "@noirwire/orderbook";
import { bytesToHex } from "@/lib/wallet/index";
import { deriveOrderSeed } from "@/lib/rollup/keys";
import { orderKeysFromCheckpoint, PACKAGE_PROGRAM_ID } from "@/lib/rollup/sdk";

/**
 * A saved checkpoint that is further behind than `OrderKeyManager.restore`'s
 * window (256 indices) makes `restore` throw "use fromView". The session
 * builder catches every error from that step and keeps `freshOrderKeys`
 * (indices 0..3), so an existing account is driven with keys its view does
 * not hold.
 */

const owner = Keypair.generate();
const seed = deriveOrderSeed(owner);
const liveKeys: PublicKey[] = [400, 401, 402, 403].map((i) => deriveOrderKey(seed, i).publicKey);
const STALE = { indices: [0, 1, 2, 3], nextIndex: 4 };
const view = { orderKeys: liveKeys };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rollup/sdk");
  vi.resetModules();
});

describe("audit: stale order-key checkpoint", () => {
  it("orderKeysFromCheckpoint recovers the live keys from a stale checkpoint", () => {
    const recovered = (() => {
      try {
        return orderKeysFromCheckpoint(seed, view as never, STALE).publicKeys.map((k) =>
          k.toBase58(),
        );
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    expect(recovered).toEqual(liveKeys.map((k) => k.toBase58()));
  });

  it("buildRealSession ends up holding the account's live order keys", async () => {
    const store = new Map<string, string>([
      [`noirwire-terminal-rollup-checkpoint-${owner.publicKey.toBase58()}`, JSON.stringify(STALE)],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });

    vi.doMock("@/lib/rollup/sdk", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/lib/rollup/sdk")>();
      class FakeTraderClient {
        async view() {
          return view;
        }
        async ready() {}
        close() {}
      }
      return {
        ...real,
        signInAndConnect: async () => ({}),
        connectionTo: () => ({ getAccountInfo: async () => ({ data: new Uint8Array() }) }),
        decodeExchangeAccount: () => ({
          collateralToken: 0,
          tokens: [{ mint: PublicKey.default, custodyNonce: 0n }],
        }),
        TraderClient: FakeTraderClient,
      };
    });
    const { buildRealSession } = await import("@/lib/rollup/session");

    const deployment = {
      network: "devnet",
      // The session refuses any program but the one this build trusts.
      programId: PACKAGE_PROGRAM_ID.toBase58(),
      solanaRpcUrl: "https://solana.example",
      rollupRpcUrl: "https://rollup.example",
      rollupWsUrl: "wss://rollup.example",
      exchange: Keypair.generate().publicKey.toBase58(),
      stats: Keypair.generate().publicKey.toBase58(),
      markets: [],
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(deployment), { status: 200 })) as typeof fetch;

    const session = await buildRealSession(
      { publicKey: owner.publicKey.toBase58(), secretKeyHex: bytesToHex(owner.secretKey) },
      { simUrl: "https://sim-checkpoint.example", fetchFn },
    );
    expect(session.orderKeyPublicKeys).toEqual(liveKeys.map((k) => k.toBase58()));
  });
});
