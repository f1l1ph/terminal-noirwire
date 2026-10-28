import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { ownerDataKeys } from "@/lib/wallet/index";
import {
  MARKET_KIND_CODE,
  programInstructions,
  VIEW_NOT_READABLE_MESSAGE,
  type SignMessage,
} from "@/lib/rollup/sdk";

type Mode = "message" | "transaction";

const OWNER = Keypair.generate();
const GATE = Keypair.generate();
const ADDRESS = OWNER.publicKey.toBase58();
const BASE_MINT = Keypair.generate().publicKey.toBase58();
const SIM = "https://sim-prompts.example";
const LOGIN = "Login to Query Filtering Service";

const PERP = {
  marketId: 0,
  symbol: "NSOL-PERP",
  kind: "perp" as const,
  market: Keypair.generate().publicKey.toBase58(),
  tape: Keypair.generate().publicKey.toBase58(),
  priceFeed: Keypair.generate().publicKey.toBase58(),
  baseToken: null,
  quoteToken: { symbol: "USDC", mint: MAINNET_PINS.usdcMint, decimals: 6 },
  baseDecimals: 9,
  quoteDecimals: 6,
  lotSize: "1000000",
  tick: "100",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rollup/sdk");
  vi.doUnmock("@/lib/rollup/orderSeedStore");
  vi.resetModules();
});

/**
 * One Open click on a real session build, in a browser whose storage refuses
 * to keep the sign-in token. The page loaded in `cached` mode; by the click
 * the service describes `served` and answers prepare in `answers`.
 */
async function click(modes: { cached: Mode; served: Mode; answers: Mode; submit?: Response }) {
  const store = new Map<string, string>();
  const tokenKey = ownerDataKeys.signInToken(ADDRESS);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === tokenKey) throw new Error("storage is full");
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    },
  });
  const seeds = new Map<string, Uint8Array>();
  vi.doMock("@/lib/rollup/orderSeedStore", () => ({
    loadOrderSeed: async (owner: string) => seeds.get(owner) ?? null,
    createOrderSeed: async (owner: string) => {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      seeds.set(owner, seed);
      return seed;
    },
    orderSeedPersisted: () => true,
  }));
  const marketAddress = (real: typeof import("@/lib/rollup/sdk")) =>
    real.programAddresses(new PublicKey(MAINNET_PINS.programId)).market(0).toBase58();
  vi.doMock("@/lib/rollup/sdk", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/rollup/sdk")>();
    class FakeTraderClient {
      async view() {
        throw new Error(VIEW_NOT_READABLE_MESSAGE);
      }
      async ready() {}
      close() {}
      subscribeView() {
        return async () => {};
      }
    }
    return {
      ...real,
      signInWithExpiry: async (_url: string, _reader: PublicKey, signMessage: SignMessage) => {
        await signMessage(new TextEncoder().encode(`${LOGIN}\nTimestamp: 1\nUser: ${ADDRESS}`));
        return { token: "session-token-0001", expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000 };
      },
      connectWithToken: () => ({
        getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
          addresses.map((address) =>
            address.toBase58() === marketAddress(real) ? { data: Uint8Array.of(0) } : null,
          ),
      }),
      connectionTo: () => ({ getAccountInfo: async () => ({ data: new Uint8Array() }) }),
      decodeExchangeAccount: () => ({
        collateralToken: 0,
        gate: GATE.publicKey,
        tokens: [MAINNET_PINS.usdcMint, BASE_MINT].map((mint, index) => ({
          mint: new PublicKey(mint),
          custodyNonce: BigInt(index),
        })),
      }),
      decodeMarketAccount: () => ({
        header: { tag: "nwmarket", ready: true, marketId: 0, bump: 0 },
        params: {
          marketId: 0,
          kind: MARKET_KIND_CODE.perp,
          baseLot: 1_000_000n,
          tick: 100n,
          baseToken: 0,
          quoteToken: 0,
        },
        baseSymbol: "NSOL",
        quoteSymbol: "NUSD",
        capacity: 1024,
      }),
      TraderClient: FakeTraderClient,
    };
  });

  const { RollupTradingClient } = await import("@/lib/trading/rollupClient");
  const { mainnetOwnerSigner } = await import("@/lib/rollup/mainnetOwner");

  let described = modes.cached;
  let describedCalls = 0;
  const events: string[] = [];
  const answerFor = (mode: Mode, orderKeys: string[]) => {
    if (mode === "message") {
      const expiresAt = Math.floor(Date.now() / 1000) + 100;
      return json(200, { expiresAt, expiresAtMs: expiresAt * 1000 });
    }
    const transaction = new Transaction({
      feePayer: GATE.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }).add(
      programInstructions(new PublicKey(MAINNET_PINS.programId)).openTrader(
        GATE.publicKey,
        OWNER.publicKey,
        orderKeys.map((key) => new PublicKey(key)),
      ),
    );
    transaction.partialSign(GATE);
    return json(200, {
      transaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      expiresAtMs: Date.now() + 45_000,
    });
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/deployment")) {
      describedCalls += 1;
      if (describedCalls > 1) described = modes.served;
      return json(200, {
        network: "mainnet",
        programId: MAINNET_PINS.programId,
        solanaRpcUrl: "https://solana.example",
        rollupRpcUrl: MAINNET_PINS.rollupRpcUrl,
        rollupWsUrl: MAINNET_PINS.rollupWsUrl,
        exchange: Keypair.generate().publicKey.toBase58(),
        stats: Keypair.generate().publicKey.toBase58(),
        markets: [PERP],
        ...(described === "message" ? { ownerAuth: "message" } : {}),
      });
    }
    if (url.endsWith("/v1/open/prepare")) {
      events.push("prepare");
      const body = JSON.parse(String(init?.body)) as { orderKeys: string[] };
      return answerFor(modes.answers, body.orderKeys);
    }
    if (url.endsWith("/v1/open/submit")) {
      events.push("submit");
      return modes.submit ?? json(200, { reference: "sig-open" });
    }
    return json(200, { result: { identity: MAINNET_PINS.validator } });
  }) as typeof fetch;

  const real = keypairOwnerSigner(OWNER);
  const signMessage = vi.fn(real.signMessage);
  const signTransaction = vi.fn(real.signTransaction);
  const signer = mainnetOwnerSigner(
    { publicKey: OWNER.publicKey, signMessage, signTransaction },
    "https://solana-rpc.example",
    {
      solana: { getGenesisHash: async () => MAINNET_PINS.solanaGenesis },
      rollupIdentity: async () => MAINNET_PINS.validator,
    },
  );
  const client = new RollupTradingClient({
    simUrl: SIM,
    overrides: { pins: MAINNET_PINS, programId: MAINNET_PINS.programId },
    marketSettingsLookup: () => undefined,
    fetchFn,
  });
  const outcome = await client.openAccount({ address: ADDRESS, signer });
  const prompts = signMessage.mock.calls.map(([bytes]) =>
    new TextDecoder().decode(bytes as Uint8Array).startsWith(LOGIN) ? "sign-in" : "message",
  );
  return { outcome, events, prompts, signTransaction };
}

describe("one Open click after the deployment switched modes, with storage that keeps no sign-in token", () => {
  it("asks for one sign-in and one owner-action message, never a second sign-in", async () => {
    const run = await click({ cached: "transaction", served: "message", answers: "message" });
    expect(run.outcome).toEqual({ kind: "opened", reference: "sig-open" });
    expect(run.prompts).toEqual(["sign-in", "message"]);
    expect(run.signTransaction).not.toHaveBeenCalled();
  });

  it("after a 400 on the transaction submit, asks for one sign-in and one transaction, nothing more", async () => {
    const run = await click({
      cached: "transaction",
      served: "message",
      answers: "transaction",
      submit: json(400, { error: "the request is not a transaction" }),
    });
    expect(run.outcome.kind).toBe("notSent");
    expect(run.events).toEqual(["prepare", "submit"]);
    expect(run.prompts).toEqual(["sign-in"]);
    expect(run.signTransaction).toHaveBeenCalledTimes(1);
  });
});
