import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveOrderKey } from "@noirwire/orderbook";
import { bytesToHex } from "@/lib/wallet/index";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { deriveLegacyOrderSeed, deriveOrderSeed } from "@/lib/rollup/keys";
import type { DeploymentOverrides, PublicDeployment } from "@/lib/rollup/deployment";
import {
  freshOrderKeys,
  MARKET_KIND_CODE,
  PACKAGE_PROGRAM_ID,
  VIEW_NOT_READABLE_MESSAGE,
  type SignMessage,
} from "@/lib/rollup/sdk";

const QUOTE_MINT = Keypair.generate().publicKey.toBase58();
const BASE_MINT = Keypair.generate().publicKey.toBase58();
const EXCHANGE_MINTS = [QUOTE_MINT, BASE_MINT];
const COLLATERAL_CUSTODY_NONCE = 0x0bad_cafe_0000_0001n;

type DeploymentMarket = PublicDeployment["markets"][number];

const PERP: DeploymentMarket = {
  marketId: 0,
  symbol: "NSOL-PERP",
  kind: "perp",
  market: Keypair.generate().publicKey.toBase58(),
  tape: Keypair.generate().publicKey.toBase58(),
  priceFeed: Keypair.generate().publicKey.toBase58(),
  baseToken: null,
  quoteToken: { symbol: "nUSD", mint: QUOTE_MINT, decimals: 6 },
  baseDecimals: 9,
  quoteDecimals: 6,
  lotSize: "1000000",
  tick: "100",
};

const SPOT: DeploymentMarket = {
  ...PERP,
  marketId: 2,
  symbol: "NSOL-NUSD",
  kind: "spot",
  baseToken: { symbol: "nSOL", mint: BASE_MINT, decimals: 9 },
};

/** The market accounts the rollup holds, by market id, as the package decodes them. */
const CHAIN = new Map([
  [0, chainMarket(0, MARKET_KIND_CODE.perp, 0)],
  [2, chainMarket(2, MARKET_KIND_CODE.spot, 1)],
]);

function chainMarket(marketId: number, kind: number, baseToken: number) {
  return {
    header: { tag: "nwmarket", ready: true, marketId, bump: 0 },
    params: { marketId, kind, baseLot: 1_000_000n, tick: 100n, baseToken, quoteToken: 0 },
    baseSymbol: "NSOL",
    quoteSymbol: "NUSD",
    capacity: 1024,
  };
}

function deployment(
  markets: DeploymentMarket[],
  programId = PACKAGE_PROGRAM_ID.toBase58(),
  network = "devnet",
) {
  return {
    network,
    programId,
    solanaRpcUrl: "https://solana.example",
    rollupRpcUrl: "https://rollup.example",
    rollupWsUrl: "wss://rollup.example",
    exchange: Keypair.generate().publicKey.toBase58(),
    stats: Keypair.generate().publicKey.toBase58(),
    markets,
  };
}

interface Stage {
  markets?: DeploymentMarket[];
  programId?: string;
  network?: string;
  identityAnswer?: () => Response;
  overrides?: DeploymentOverrides;
  view?: () => Promise<{ orderKeys: PublicKey[] }>;
}

async function build(owner: Keypair, stage: Stage = {}) {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  const installed: string[][] = [];
  let signer: SignMessage | null = null;
  const view = stage.view ?? (async () => ({ orderKeys: [] as PublicKey[] }));

  vi.doMock("@/lib/rollup/sdk", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/rollup/sdk")>();
    class FakeTraderClient {
      view = view;
      async ready() {}
      close() {}
    }
    const marketAddresses = new Map(
      [...CHAIN.keys()].map((id) => [
        real.programAddresses(PACKAGE_PROGRAM_ID).market(id).toBase58(),
        id,
      ]),
    );
    return {
      ...real,
      signInAndConnect: async (_url: string, _reader: PublicKey, signMessage: SignMessage) => {
        signer = signMessage;
        return {
          getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
            addresses.map((address) => {
              const id = marketAddresses.get(address.toBase58());
              return id === undefined ? null : { data: Uint8Array.of(id) };
            }),
        };
      },
      connectionTo: () => ({ getAccountInfo: async () => ({ data: new Uint8Array() }) }),
      decodeExchangeAccount: () => ({
        collateralToken: 0,
        tokens: EXCHANGE_MINTS.map((mint, index) => ({
          mint: new PublicKey(mint),
          custodyNonce: COLLATERAL_CUSTODY_NONCE + BigInt(index),
        })),
      }),
      decodeMarketAccount: (data: Uint8Array) => CHAIN.get(data[0]),
      installOrderKeys: async (_c: unknown, _o: unknown, keys: { publicKeys: PublicKey[] }) => {
        installed.push(keys.publicKeys.map((key) => key.toBase58()));
      },
      TraderClient: FakeTraderClient,
    };
  });
  const { buildRealSession } = await import("@/lib/rollup/session");
  const body = deployment(stage.markets ?? [PERP, SPOT], stage.programId, stage.network);
  const fetchFn = (async (_url: unknown, init?: RequestInit) =>
    String(init?.body).includes("getIdentity")
      ? (stage.identityAnswer?.() ??
        new Response(JSON.stringify({ result: { identity: MAINNET_PINS.validator } })))
      : new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const session = buildRealSession(
    { publicKey: owner.publicKey.toBase58(), secretKeyHex: bytesToHex(owner.secretKey) },
    { simUrl: "https://sim-session.example", fetchFn, overrides: stage.overrides },
  );
  return { session, installed, signer: () => signer };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rollup/sdk");
  vi.resetModules();
});

const notOpened = async () => {
  throw new Error(VIEW_NOT_READABLE_MESSAGE);
};

const symbolsOf = async (built: ReturnType<typeof build>) =>
  (await (await built).session).deployment.markets.map((market) => market.symbol);

describe("buildRealSession: a mainnet build trusts only the pinned collateral", () => {
  it("refuses an exchange whose collateral mint is not the USDC pin", async () => {
    const owner = Keypair.generate();
    const markets = [
      { ...PERP, quoteToken: { symbol: "USDC", mint: MAINNET_PINS.usdcMint, decimals: 6 } },
    ];
    const built = build(owner, {
      view: notOpened,
      markets,
      network: "mainnet",
      programId: MAINNET_PINS.programId,
      overrides: { pins: MAINNET_PINS },
    });
    await expect((await built).session).rejects.toThrow(/collateral/);
  });

  it("asks for no signature when the rollup is run by another validator", async () => {
    const owner = Keypair.generate();
    const markets = [
      { ...PERP, quoteToken: { symbol: "USDC", mint: MAINNET_PINS.usdcMint, decimals: 6 } },
    ];
    const built = await build(owner, {
      view: notOpened,
      markets,
      network: "mainnet",
      programId: MAINNET_PINS.programId,
      overrides: { pins: MAINNET_PINS },
      identityAnswer: () =>
        new Response(JSON.stringify({ result: { identity: owner.publicKey.toBase58() } })),
    });
    await expect(built.session).rejects.toThrow(/is run by/);
    expect(built.signer()).toBeNull();
  });
});

describe("buildRealSession: markets are bound only when the rollup's own market account agrees", () => {
  it("keeps markets whose entry matches the chain", async () => {
    const owner = Keypair.generate();
    expect(await symbolsOf(build(owner, { view: notOpened }))).toEqual(["NSOL-PERP", "NSOL-NUSD"]);
  });

  it("keeps the Exchange's own collateral token, mint and custody nonce, for the funding check", async () => {
    const owner = Keypair.generate();
    const { session } = await build(owner, { view: notOpened });
    const { collateralToken } = await session;
    expect(collateralToken.mint.toBase58()).toBe(QUOTE_MINT);
    expect(collateralToken.custodyNonce).toBe(COLLATERAL_CUSTODY_NONCE);
  });

  it("drops a market whose reported base decimals disagree with this build's pin", async () => {
    const owner = Keypair.generate();
    const markets = [{ ...PERP, baseDecimals: 12 }, SPOT];
    expect(await symbolsOf(build(owner, { view: notOpened, markets }))).toEqual(["NSOL-NUSD"]);
  });

  it("drops markets whose ids were swapped", async () => {
    const owner = Keypair.generate();
    const markets = [
      { ...PERP, marketId: 2 },
      { ...SPOT, marketId: 0 },
    ];
    expect(await symbolsOf(build(owner, { view: notOpened, markets }))).toEqual([]);
  });

  it("drops a market whose lot disagrees with the chain", async () => {
    const owner = Keypair.generate();
    const markets = [{ ...PERP, lotSize: "1000" }, SPOT];
    expect(await symbolsOf(build(owner, { view: notOpened, markets }))).toEqual(["NSOL-NUSD"]);
  });

  it("drops a spot market whose base mint is not the one the exchange registered", async () => {
    const owner = Keypair.generate();
    const wrongMint = Keypair.generate().publicKey.toBase58();
    const markets = [
      PERP,
      { ...SPOT, baseToken: { symbol: "nSOL", mint: wrongMint, decimals: 9 } },
    ];
    expect(await symbolsOf(build(owner, { view: notOpened, markets }))).toEqual(["NSOL-PERP"]);
  });

  it("refuses a deployment that names another program", async () => {
    const owner = Keypair.generate();
    const programId = Keypair.generate().publicKey.toBase58();
    const { session } = await build(owner, { view: notOpened, programId });
    await expect(session).rejects.toThrow(/this build trades on/);
  });

  it("refuses a deployment that names another program than the configured override", async () => {
    const owner = Keypair.generate();
    const overrides = { programId: Keypair.generate().publicKey.toBase58() };
    const { session } = await build(owner, { view: notOpened, overrides });
    await expect(session).rejects.toThrow(/this build trades on/);
  });
});

describe("buildRealSession: order keys", () => {
  it("signs in with a signer that refuses anything but a sign-in challenge", async () => {
    const owner = Keypair.generate();
    const built = await build(owner, { view: notOpened });
    await built.session;
    const domain = new TextEncoder().encode("noirwire-terminal/order-key-seed/v1");
    await expect(built.signer()!(domain)).rejects.toThrow();
    const challenge = new TextEncoder().encode(
      `Login to Query Filtering Service\nTimestamp: 1792505080\nUser: ${owner.publicKey.toBase58()}`,
    );
    await expect(built.signer()!(challenge)).resolves.toHaveLength(64);
  });

  it("starts from the fresh keys, installing nothing, when the account is not opened yet", async () => {
    const owner = Keypair.generate();
    const { session, installed } = await build(owner, { view: notOpened });
    const fresh = freshOrderKeys(deriveOrderSeed(owner)).publicKeys.map((key) => key.toBase58());
    expect((await session).orderKeyPublicKeys).toEqual(fresh);
    expect(installed).toEqual([]);
  });

  it("replaces keys installed under the earlier, signature-based seed with keys from the new one", async () => {
    const owner = Keypair.generate();
    const legacy = freshOrderKeys(deriveLegacyOrderSeed(owner)).publicKeys;
    const { session, installed } = await build(owner, {
      view: async () => ({ orderKeys: legacy }),
    });
    const fresh = freshOrderKeys(deriveOrderSeed(owner)).publicKeys.map((key) => key.toBase58());
    expect((await session).orderKeyPublicKeys).toEqual(fresh);
    expect(installed).toEqual([fresh]);
  });

  it("keeps the account's own keys from the new seed, installing nothing", async () => {
    const owner = Keypair.generate();
    const inView = [5, 1, 2, 7].map(
      (index) => deriveOrderKey(deriveOrderSeed(owner), index).publicKey,
    );
    const { session, installed } = await build(owner, {
      view: async () => ({ orderKeys: inView }),
    });
    expect((await session).orderKeyPublicKeys).toEqual(inView.map((key) => key.toBase58()));
    expect(installed).toEqual([]);
  });

  it("fails the build, rather than using fresh keys, when the view read itself fails", async () => {
    const owner = Keypair.generate();
    const { session, installed } = await build(owner, {
      view: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(session).rejects.toThrow("fetch failed");
    expect(installed).toEqual([]);
  });
});
