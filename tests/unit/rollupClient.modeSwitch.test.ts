import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import { programInstructions, VIEW_NOT_READABLE_MESSAGE } from "@/lib/rollup/sdk";
import type { WalletIdentity } from "@/lib/trading/types";

type Mode = "message" | "transaction";

const PROGRAM = new PublicKey(MAINNET_PINS.programId);
const GATE = Keypair.generate();
const OWNER = Keypair.generate();
const ORDER_KEYS = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const NOW = 1_800_000_000_000;
const EXPIRES_AT = NOW / 1000 + 100;
const SIM = "https://sim.example";

const deployment = (mode: Mode): PublicDeployment => ({
  network: "mainnet",
  programId: MAINNET_PINS.programId,
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  rollupRpcUrl: MAINNET_PINS.rollupRpcUrl,
  rollupWsUrl: MAINNET_PINS.rollupWsUrl,
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
  ...(mode === "message" ? { ownerAuth: "message" as const } : {}),
});

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function preparedTransaction(): string {
  const transaction = new Transaction({
    feePayer: GATE.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }).add(programInstructions(PROGRAM).openTrader(GATE.publicKey, OWNER.publicKey, ORDER_KEYS));
  transaction.partialSign(GATE);
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

const answerFor = (mode: Mode) =>
  mode === "message"
    ? json(200, { expiresAt: EXPIRES_AT, expiresAtMs: EXPIRES_AT * 1000 })
    : json(200, { transaction: preparedTransaction(), expiresAtMs: NOW + 45_000 });

/**
 * `cached` is the mode the page read at load; the first session is built on
 * it. `afterRefresh` is what the service describes when it is asked again,
 * and `answers` is what `/v1/open/prepare` actually answers in.
 */
function harness(modes: { cached: Mode; afterRefresh: Mode; answers: Mode; submit?: Response }) {
  const events: string[] = [];
  let builds = 0;
  const real = keypairOwnerSigner(OWNER);
  const signMessage = vi.fn(real.signMessage);
  const signTransaction = vi.fn(async (tx: Transaction) => real.signTransaction(tx));
  const signer: OwnerSigner = { publicKey: OWNER.publicKey, signMessage, signTransaction };

  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/open/prepare")) {
      events.push("prepare");
      return answerFor(modes.answers);
    }
    if (url.endsWith("/v1/open/submit")) {
      events.push("submit");
      return modes.submit ?? json(200, { reference: "sig-open" });
    }
    throw new Error(`unexpected request ${url}`);
  });

  const session = (mode: Mode): RollupSession => ({
    owner: signer,
    orderKeyPublicKeys: ORDER_KEYS.map((key) => key.toBase58()),
    client: {
      view: async () => {
        throw new Error(VIEW_NOT_READABLE_MESSAGE);
      },
      subscribeView: () => async () => {},
    } as unknown as TraderClientLike,
    deployment: deployment(mode),
    tokenIndexBySymbol: new Map(),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: GATE.publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  });

  const client = new RollupTradingClient({
    simUrl: SIM,
    overrides: { pins: MAINNET_PINS, programId: MAINNET_PINS.programId },
    marketSettingsLookup: () => undefined,
    storage: memoryStore(),
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => NOW,
    buildSession: async () => {
      builds += 1;
      return session(builds === 1 ? modes.cached : modes.afterRefresh);
    },
  });
  const wallet: WalletIdentity = { address: OWNER.publicKey.toBase58(), signer };
  return { client, wallet, events, signMessage, signTransaction };
}

describe("an open when the deployment switched modes after the page loaded", () => {
  it("opens in message mode after one refresh, with one wallet signature, when transaction mode was cached", async () => {
    const h = harness({ cached: "transaction", afterRefresh: "message", answers: "message" });
    expect(await h.client.openAccount(h.wallet)).toEqual({ kind: "opened", reference: "sig-open" });
    expect(h.events).toEqual(["prepare", "prepare", "submit"]);
    expect(h.signMessage).toHaveBeenCalledTimes(1);
    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("opens in transaction mode after one refresh, with one wallet signature, when message mode was cached", async () => {
    const h = harness({ cached: "message", afterRefresh: "transaction", answers: "transaction" });
    expect(await h.client.openAccount(h.wallet)).toEqual({ kind: "opened", reference: "sig-open" });
    expect(h.events).toEqual(["prepare", "prepare", "submit"]);
    expect(h.signTransaction).toHaveBeenCalledTimes(1);
    expect(h.signMessage).not.toHaveBeenCalled();
  });

  it("asks for a reload when the mode still disagrees after one refresh, without a wallet prompt", async () => {
    for (const [cached, answers] of [
      ["transaction", "message"],
      ["message", "transaction"],
    ] as const) {
      const h = harness({ cached, afterRefresh: cached, answers });
      const outcome = await h.client.openAccount(h.wallet);
      expect(outcome).toEqual({
        kind: "notSent",
        reason: "Opening accounts changed while this page was open. Reload the page and try again.",
      });
      expect(h.events).toEqual(["prepare", "prepare"]);
      expect(h.signMessage).not.toHaveBeenCalled();
      expect(h.signTransaction).not.toHaveBeenCalled();
    }
  });

  it("lets the trader start over after a 400 on a transaction submit once the mode is message", async () => {
    const h = harness({
      cached: "transaction",
      afterRefresh: "message",
      answers: "transaction",
      submit: json(400, { error: "the request is not a transaction" }),
    });
    expect(await h.client.openAccount(h.wallet)).toEqual({
      kind: "notSent",
      reason: "Opening accounts changed while this page was open. Nothing was opened. Try again.",
    });
    expect(h.events).toEqual(["prepare", "submit"]);
    expect(h.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps a 400 on a transaction submit as a refusal when the mode did not change", async () => {
    const h = harness({
      cached: "transaction",
      afterRefresh: "transaction",
      answers: "transaction",
      submit: json(400, { error: "bad request" }),
    });
    expect(await h.client.openAccount(h.wallet)).toEqual({
      kind: "refused",
      refusal: { kind: "rejected", status: 400 },
    });
  });
});
