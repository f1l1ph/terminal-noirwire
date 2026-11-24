import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { TriggerResult, WalletIdentity } from "@/lib/trading/types";
import { loadTrackedSecrets } from "@/lib/rollup/secretStore";
import {
  Instructions,
  PROGRAM_ID,
  RESULT_STATUS,
  TRIGGER_ERROR,
  TRIGGER_KIND,
  type OrderKeyCall,
  type TriggerState,
  type TriggerStatus,
} from "@noirwire/orderbook";
import {
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  TRIGGER_KIND_CODE,
  TransactionFailed,
  type OrderResult,
  type Timing,
  type View,
} from "@/lib/rollup/sdk";
import { KEYS_IN_USE_ELSEWHERE_REASON } from "@/lib/rollup/outcome";
import { TRIGGERS_NOT_LIVE_REASON } from "@/lib/rollup/triggerOutcome";
import { describeProgramError, PROGRAM_ERROR } from "@/lib/rollup/refusals";

const PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const USDC = 1_000_000n;
const emptySlot = { base: 0n, quote: 0n, openBidLots: 0n, openAskLots: 0n };

function viewWith(
  base: bigint,
  resultsWritten: number,
  triggerStatus: TriggerStatus | null = null,
): View {
  return {
    orderKeys: [],
    resultsWritten,
    results: [],
    seatRecorded: true,
    snapshotOld: false,
    snapshot: {
      seat: {
        collateral: 500n * USDC,
        spot: [],
        positions: [{ ...emptySlot, marketId: 0, base, quote: base === 0n ? 0n : -1000n * USDC }],
      },
      marketId: 0,
      orders: [],
      triggerStatus,
    },
  } as unknown as View;
}

function status(takeProfit: TriggerState, stopLoss: TriggerState): TriggerStatus {
  return { marketId: 0, takeProfit, stopLoss };
}

const DEPLOYMENT: PublicDeployment = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [
    {
      marketId: 0,
      symbol: "NSOL-PERP",
      kind: "perp",
      market: Keypair.generate().publicKey.toBase58(),
      tape: Keypair.generate().publicKey.toBase58(),
      priceFeed: Keypair.generate().publicKey.toBase58(),
      baseToken: null,
      quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
      baseDecimals: 9,
      quoteDecimals: 6,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };
const REQUEST = {
  kind: "takeProfit" as const,
  price: "160.00",
  worstPrice: "158.40",
  size: null,
};

type SentResult = OrderResult & Timing & { secret: Uint8Array };

function result(overrides: Partial<OrderResult> = {}): SentResult {
  return {
    sentAt: 0,
    resultAt: 1,
    clientOrderId: 1n,
    orderSeq: 0n,
    filled: 0n,
    filledNotional: 0n,
    rested: 0n,
    cancelled: 0n,
    fee: 0n,
    kind: 10,
    status: RESULT_STATUS.done,
    code: 0,
    secret: new Uint8Array(16),
    ...overrides,
  } as unknown as SentResult;
}

const refused = (code: number) => result({ status: RESULT_STATUS_CODE.refused, code });

const notOrderKey = () =>
  new TransactionFailed("sig", {
    InstructionError: [0, { Custom: 6000 + PROGRAM_ERROR.notOrderKey }],
  });

function setup(
  overrides: Partial<TraderClientLike>,
  options: { live?: boolean; views?: View[]; keypair?: Keypair } = {},
) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const unused = async () => {
    throw new Error("unused");
  };
  const views = options.views ?? [viewWith(2000n, 1)];
  let read = 0;
  const syncs: number[] = [];
  const client: TraderClientLike = {
    view: async () => views[Math.min(read++, views.length - 1)],
    subscribeView: () => async () => {},
    placeOrder: unused,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: async (marketId) => {
      syncs.push(marketId);
      return { ...refusedOk(), sentAt: 0, resultAt: 1 };
    },
    transferBetweenBalances: unused,
    ...overrides,
  };
  const session: RollupSession = {
    owner: keypairOwnerSigner(options.keypair ?? Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    triggersLive: options.live ?? true,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    resyncKeys: () => {},
    close: () => {},
  };
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async () => session,
  });
  return { rollup, storage, syncs };
}

function refusedOk(): OrderResult {
  return result({ status: RESULT_STATUS.done }) as OrderResult;
}

describe("take profit and stop loss through the trading client", () => {
  it("is available only once the exchange runs the active layout", async () => {
    const live = setup({ setTrigger: async () => result() });
    expect(await live.rollup.triggersAvailable(WALLET)).toBe(true);
    const old = setup({ setTrigger: async () => result() }, { live: false });
    expect(await old.rollup.triggersAvailable(WALLET)).toBe(false);
    const noRoute = setup({});
    expect(await noRoute.rollup.triggersAvailable(WALLET)).toBe(false);
  });

  it("refuses to send anything before the layout is active", async () => {
    let sends = 0;
    const { rollup } = setup(
      {
        setTrigger: async () => {
          sends += 1;
          return result();
        },
      },
      { live: false },
    );
    const outcome = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(sends).toBe(0);
    expect(outcome).toEqual({ kind: "refused", reason: TRIGGERS_NOT_LIVE_REASON });
  });

  it("sends prices in quote atoms per lot and the whole position as size zero, and keeps the secret", async () => {
    let sent: Parameters<NonNullable<TraderClientLike["setTrigger"]>> | null = null;
    const { rollup, storage, syncs } = setup({
      setTrigger: async (...args) => {
        sent = args;
        return result();
      },
    });
    const outcome = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(outcome).toEqual({ kind: "ok" });
    expect(sent).not.toBeNull();
    const [marketId, trigger] = sent!;
    expect(marketId).toBe(0);
    expect(trigger.kind).toBe(TRIGGER_KIND.takeProfit);
    expect(trigger.triggerPrice).toBe(160_000n);
    expect(trigger.worstPrice).toBe(158_400n);
    expect(trigger.size).toBe(0n);
    expect(trigger.expiry).toBe(0n);
    expect(trigger.secret).toHaveLength(16);
    const tracked = loadTrackedSecrets(storage, WALLET.address);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].market).toBe("NSOL-PERP");
    expect(syncs).toEqual([0]);
  });

  it("sends a fixed size in lots", async () => {
    let size = -1n;
    const { rollup } = setup({
      setTrigger: async (_market, trigger) => {
        size = trigger.size;
        return result();
      },
    });
    await rollup.setTrigger(WALLET, "NSOL-PERP", { ...REQUEST, size: "0.750" });
    expect(size).toBe(750n);
  });

  it("maps a refusal to its sentence and forgets the secret of a trigger that never existed", async () => {
    const { rollup, storage } = setup({
      setTrigger: async () => refused(TRIGGER_ERROR.wouldFireImmediately),
    });
    const outcome = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(outcome).toEqual({
      kind: "refused",
      reason: describeProgramError(TRIGGER_ERROR.wouldFireImmediately),
    });
    expect(loadTrackedSecrets(storage, WALLET.address)).toHaveLength(0);
  });

  it("maps a failed transaction with a trigger code to the same sentence", async () => {
    const { rollup } = setup({
      setTrigger: async () => {
        throw new TransactionFailed("sig", {
          InstructionError: [0, { Custom: 6000 + TRIGGER_ERROR.pairCrossed }],
        });
      },
    });
    const outcome = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(outcome).toEqual({
      kind: "refused",
      reason: describeProgramError(TRIGGER_ERROR.pairCrossed),
    });
  });

  it("resyncs a dead order key once and says so when it is still refused", async () => {
    let sends = 0;
    const { rollup } = setup({
      setTrigger: async () => {
        sends += 1;
        throw notOrderKey();
      },
    });
    const outcome = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(sends).toBe(2);
    expect(outcome).toEqual({ kind: "refused", reason: KEYS_IN_USE_ELSEWHERE_REASON });
  });

  it("removes a trigger by kind", async () => {
    let kind = -1;
    const { rollup, syncs } = setup({
      cancelTrigger: async (_market, which) => {
        kind = which;
        return result({ kind: 11, cancelled: 1n });
      },
    });
    const outcome = await rollup.cancelTrigger(WALLET, "NSOL-PERP", "stopLoss");
    expect(outcome).toEqual({ kind: "ok" });
    expect(kind).toBe(TRIGGER_KIND_CODE.stopLoss);
    expect(syncs).toEqual([0]);
  });

  it("reports each market's trigger status from the view, and keeps it across views that carry none", async () => {
    const statuses = status(
      { state: "armed" },
      { state: "unfillable", nextAttempt: 1_700_000_010n },
    );
    const { rollup } = setup(
      {},
      { views: [viewWith(2000n, 5, statuses), viewWith(2000n, 6, null)] },
    );
    const first = await rollup.fetchState(WALLET);
    expect(first.triggers?.["NSOL-PERP"].takeProfit).toEqual({ state: "armed" });
    expect(first.triggers?.["NSOL-PERP"].stopLoss).toEqual({
      state: "unfillable",
      nextAttemptMs: 1_700_000_010_000,
    });
    const readAt = first.triggers!["NSOL-PERP"].readAtMs;
    const second = await rollup.fetchState(WALLET);
    expect(second.triggers?.["NSOL-PERP"].readAtMs).toBe(readAt);
  });

  it("marks the retained status stale when a later view carries no report, and clears it when one returns", async () => {
    const armed = status({ state: "armed" }, { state: "gone" });
    const { rollup } = setup(
      {},
      {
        views: [
          viewWith(2000n, 5, armed),
          viewWith(2000n, 5, armed),
          viewWith(2000n, 6, null),
          viewWith(2000n, 7, armed),
        ],
      },
    );
    const first = await rollup.fetchState(WALLET);
    expect(first.triggers?.["NSOL-PERP"].stale).toBeFalsy();
    const second = await rollup.fetchState(WALLET);
    expect(second.triggers?.["NSOL-PERP"].stale).toBe(true);
    expect(second.triggers?.["NSOL-PERP"].takeProfit).toEqual({ state: "armed" });
    const third = await rollup.fetchState(WALLET);
    expect(third.triggers?.["NSOL-PERP"].stale).toBeFalsy();
  });

  it("keeps a trigger's secret pinned, then releases it when the trigger is cancelled, replaced or reported gone", async () => {
    const pinnedFor = (storage: { getItem(key: string): string | null }) =>
      loadTrackedSecrets(storage as never, WALLET.address).filter((entry) => entry.pinned);
    const { rollup, storage } = setup({
      setTrigger: async () => result(),
      cancelTrigger: async () => result({ kind: 11, cancelled: 1n }),
    });
    await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(pinnedFor(storage)).toHaveLength(1);
    expect(pinnedFor(storage)[0].trigger).toBe("takeProfit");
    await rollup.setTrigger(WALLET, "NSOL-PERP", { ...REQUEST, price: "165.00" });
    expect(pinnedFor(storage)).toHaveLength(1);
    expect(loadTrackedSecrets(storage, WALLET.address)).toHaveLength(2);
    await rollup.cancelTrigger(WALLET, "NSOL-PERP", "takeProfit");
    expect(pinnedFor(storage)).toHaveLength(0);

    const keypair = Keypair.generate();
    const owned: WalletIdentity = { ...WALLET, address: keypair.publicKey.toBase58() };
    const gone = setup(
      { setTrigger: async () => result() },
      {
        keypair,
        views: [
          ...[5, 6, 7, 8, 9, 10, 11].map((written) =>
            viewWith(2000n, written, status({ state: "gone" }, { state: "gone" })),
          ),
        ],
      },
    );
    await gone.rollup.setTrigger(owned, "NSOL-PERP", REQUEST);
    for (let read = 0; read < 4; read++) await gone.rollup.fetchState(owned);
    expect(loadTrackedSecrets(gone.storage, owned.address)).toHaveLength(1);
    expect(loadTrackedSecrets(gone.storage, owned.address)[0].pinned).toBeUndefined();
  });

  it("keeps the replaced trigger's secret pinned until a pending replacement is known to have gone through", async () => {
    const pinnedFor = (storage: { getItem(key: string): string | null }) =>
      loadTrackedSecrets(storage as never, WALLET.address).filter((entry) => entry.pinned);
    const outcomes: Array<() => Promise<SentResult>> = [
      async () => result(),
      async () => {
        throw new OutcomeUnknown(1n, Promise.resolve(null));
      },
      async () => {
        throw new OutcomeUnknown(1n, Promise.resolve({ ...result(), sentAt: 0, resultAt: 1 }));
      },
    ];
    let call = 0;
    const { rollup, storage } = setup({ setTrigger: () => outcomes[call++]() });
    await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    const original = pinnedFor(storage)[0].secretHex;

    const unrun = await rollup.setTrigger(WALLET, "NSOL-PERP", { ...REQUEST, price: "165.00" });
    expect(unrun.kind).toBe("pending");
    expect(pinnedFor(storage).map((entry) => entry.secretHex)).toContain(original);
    if (unrun.kind !== "pending") return;
    await expect(unrun.pending.settled).resolves.toMatchObject({ kind: "refused" });
    expect(pinnedFor(storage).map((entry) => entry.secretHex)).toEqual([original]);
    expect(loadTrackedSecrets(storage, WALLET.address)).toHaveLength(1);

    const landed = await rollup.setTrigger(WALLET, "NSOL-PERP", { ...REQUEST, price: "170.00" });
    if (landed.kind !== "pending") throw new Error("expected pending");
    expect(pinnedFor(storage).map((entry) => entry.secretHex)).toContain(original);
    await expect(landed.pending.settled).resolves.toEqual({ kind: "ok" });
    const pinned = pinnedFor(storage);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].secretHex).not.toBe(original);
  });

  it("drops the status once the position is gone", async () => {
    const { rollup } = setup(
      {},
      {
        views: [
          viewWith(2000n, 5, status({ state: "armed" }, { state: "gone" })),
          viewWith(0n, 6, null),
        ],
      },
    );
    await rollup.fetchState(WALLET);
    const flat = await rollup.fetchState(WALLET);
    expect(flat.triggers).toEqual({});
  });
});

describe("the instruction the program receives", () => {
  it("is built by the package from the order key's call, with the trigger book among its accounts", () => {
    const orderKey = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const instructions = new Instructions(PROGRAM_ID);
    const call: OrderKeyCall = {
      orderKey,
      owner,
      expiresAt: 100n,
      replacement: Keypair.generate().publicKey,
      clientOrderId: 1n,
      marketId: 0,
      riskMarkets: [0],
    };
    const instruction = instructions.setTrigger(call, {
      kind: TRIGGER_KIND.stopLoss,
      triggerPrice: 140_000n,
      worstPrice: 138_600n,
      size: 0n,
      secret: new Uint8Array(16).fill(3),
    });
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    const signer = instruction.keys.find((key) => key.pubkey.equals(orderKey));
    expect(signer?.isSigner).toBe(true);
    const trigger = instructions.addresses.triggers(0);
    expect(instruction.keys.some((key) => key.pubkey.equals(trigger))).toBe(true);
    const cancel = instructions.cancelTrigger(call, TRIGGER_KIND.stopLoss);
    expect(cancel.keys.some((key) => key.pubkey.equals(trigger))).toBe(true);
    expect(cancel.data.equals(instruction.data)).toBe(false);
  });
});

describe("what a trigger result tells the caller", () => {
  it("never passes a refusal off as success", async () => {
    const { rollup } = setup({ setTrigger: async () => refused(PROGRAM_ERROR.noPosition) });
    const outcome: TriggerResult = await rollup.setTrigger(WALLET, "NSOL-PERP", REQUEST);
    expect(outcome.kind).toBe("refused");
  });
});
