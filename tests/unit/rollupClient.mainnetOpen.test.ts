import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import { programInstructions, VIEW_NOT_READABLE_MESSAGE, type View } from "@/lib/rollup/sdk";
import type { WalletIdentity } from "@/lib/trading/types";

const PROGRAM = new PublicKey(MAINNET_PINS.programId);
const GATE = Keypair.generate();
const OWNER = Keypair.generate();
const ORDER_KEYS = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const NOW = 1_800_000_000_000;
const SIM = "https://sim.example";

const OPEN_VIEW = {
  header: { tag: "nwview", ready: true, marketId: 0, bump: 0 },
  owner: OWNER.publicKey,
  orderKeys: ORDER_KEYS,
  seat: 0,
  resultsWritten: 0,
  results: [],
  snapshot: {
    seat: {
      owner: OWNER.publicKey,
      version: 0n,
      collateral: 0n,
      spot: [],
      perp: [],
      openOrders: [],
      status: 1,
    },
    seatIndex: 0,
    marketId: 0,
    orders: [],
  },
} as unknown as View;

const DEPLOYMENT: PublicDeployment = {
  network: "mainnet",
  programId: MAINNET_PINS.programId,
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  rollupRpcUrl: MAINNET_PINS.rollupRpcUrl,
  rollupWsUrl: MAINNET_PINS.rollupWsUrl,
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
};

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

/** What `/v1/open/prepare` sends: `open_trader` with the gate paying, no signature. */
function preparedBase64(shape: { feePayer?: PublicKey; extra?: boolean } = {}): string {
  const transaction = new Transaction({
    feePayer: shape.feePayer ?? GATE.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }).add(programInstructions(PROGRAM).openTrader(GATE.publicKey, OWNER.publicKey, ORDER_KEYS));
  if (shape.extra) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: OWNER.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
  }
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

interface Harness {
  client: RollupTradingClient;
  wallet: WalletIdentity;
  events: string[];
  signer: { signMessage: ReturnType<typeof vi.fn>; signTransaction: ReturnType<typeof vi.fn> };
  fetchFn: ReturnType<typeof vi.fn>;
  built: () => number;
  setOpen: (open: boolean) => void;
}

function harness(options: {
  open?: boolean;
  prepare?: () => Response;
  submit?: () => Response;
  signer?: (real: OwnerSigner) => OwnerSigner;
}): Harness {
  const events: string[] = [];
  let open = options.open ?? false;
  let builds = 0;
  const real = keypairOwnerSigner(OWNER);
  const signMessage = vi.fn(real.signMessage);
  const signTransaction = vi.fn(async (tx: Transaction) => {
    events.push("wallet asked");
    return real.signTransaction(tx);
  });
  const base: OwnerSigner = { publicKey: OWNER.publicKey, signMessage, signTransaction };
  const signer = options.signer ? options.signer(base) : base;

  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/open/prepare")) {
      events.push("prepare");
      return (
        options.prepare?.() ??
        new Response(JSON.stringify({ transaction: preparedBase64(), expiresAtMs: NOW + 45_000 }), {
          status: 200,
        })
      );
    }
    if (url.endsWith("/v1/open/submit")) {
      events.push("submit");
      return (
        options.submit?.() ??
        new Response(JSON.stringify({ reference: "sig-open" }), { status: 200 })
      );
    }
    throw new Error(`unexpected request ${url}`);
  });

  const session = (): RollupSession => ({
    owner: signer,
    orderKeyPublicKeys: ORDER_KEYS.map((key) => key.toBase58()),
    client: {
      view: async () => {
        events.push("view");
        if (!open) throw new Error(VIEW_NOT_READABLE_MESSAGE);
        return OPEN_VIEW;
      },
      subscribeView: () => async () => {},
    } as unknown as TraderClientLike,
    deployment: DEPLOYMENT,
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
      return session();
    },
  });
  return {
    client,
    wallet: { address: OWNER.publicKey.toBase58(), signer },
    events,
    signer: { signMessage, signTransaction },
    fetchFn,
    built: () => builds,
    setOpen: (value) => {
      open = value;
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("opening an account on mainnet", () => {
  it("rebuilds the transaction, has the wallet sign it once, submits it and reports the reference", async () => {
    const h = harness({});
    const outcome = await h.client.openAccount(h.wallet, "invite-code");
    expect(outcome).toEqual({ kind: "opened", reference: "sig-open" });
    expect(h.signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(h.signer.signMessage).not.toHaveBeenCalled();
  });

  it("sends the invite code and the four order keys of this session to prepare", async () => {
    const h = harness({});
    await h.client.openAccount(h.wallet, "invite-code");
    const prepareCall = h.fetchFn.mock.calls.find(([url]) => String(url).endsWith("/prepare"));
    expect(JSON.parse(String((prepareCall?.[1] as RequestInit).body))).toEqual({
      owner: OWNER.publicKey.toBase58(),
      orderKeys: ORDER_KEYS.map((key) => key.toBase58()),
      invite: "invite-code",
    });
  });

  it("does nothing when the account already exists", async () => {
    const h = harness({ open: true });
    expect(await h.client.openAccount(h.wallet)).toEqual({ kind: "alreadyOpen" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("never asks the wallet to sign a transaction the service paid for with another gate", async () => {
    const h = harness({
      prepare: () =>
        json(200, {
          transaction: preparedBase64({ feePayer: Keypair.generate().publicKey }),
          expiresAtMs: NOW + 45_000,
        }),
    });
    const outcome = await h.client.openAccount(h.wallet);
    expect(outcome.kind).toBe("notSent");
    expect(h.signer.signTransaction).not.toHaveBeenCalled();
    expect(h.events).not.toContain("submit");
  });

  it("never asks the wallet to sign a transaction with an instruction added", async () => {
    const h = harness({
      prepare: () =>
        json(200, { transaction: preparedBase64({ extra: true }), expiresAtMs: NOW + 45_000 }),
    });
    expect((await h.client.openAccount(h.wallet)).kind).toBe("notSent");
    expect(h.signer.signTransaction).not.toHaveBeenCalled();
  });

  it("never submits what the wallet signed if the wallet changed the transaction", async () => {
    const h = harness({
      signer: (base) => ({
        ...base,
        signTransaction: async (tx) => {
          const widened = Transaction.from(
            tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          );
          widened.add(
            SystemProgram.transfer({
              fromPubkey: OWNER.publicKey,
              toPubkey: Keypair.generate().publicKey,
              lamports: 1,
            }),
          );
          return keypairOwnerSigner(OWNER).signTransaction(widened);
        },
      }),
    });
    const outcome = await h.client.openAccount(h.wallet);
    expect(outcome.kind).toBe("notSent");
    expect(h.events).not.toContain("submit");
  });

  it("does not sign when the prepared transaction is about to expire", async () => {
    const h = harness({
      prepare: () => json(200, { transaction: preparedBase64(), expiresAtMs: NOW + 2_000 }),
    });
    expect((await h.client.openAccount(h.wallet)).kind).toBe("notSent");
    expect(h.signer.signTransaction).not.toHaveBeenCalled();
  });

  it("reports a refused invite as a typed refusal, signing nothing", async () => {
    const h = harness({ prepare: () => json(403, { error: "this address is not on the list" }) });
    expect(await h.client.openAccount(h.wallet, "wrong-code")).toEqual({
      kind: "refused",
      refusal: { kind: "notInvited" },
    });
    expect(h.signer.signTransaction).not.toHaveBeenCalled();
  });
});

describe("an answer that leaves the account possibly open is settled by reading the view", () => {
  it("reads the view after a submit the rollup did not confirm, and reports an account that exists", async () => {
    const h = harness({
      submit: () => {
        h.setOpen(true);
        return json(502, { error: "the rollup did not confirm in time" });
      },
    });
    const outcome = await h.client.openAccount(h.wallet);
    expect(outcome).toEqual({ kind: "alreadyOpen" });
    expect(h.events.slice(h.events.indexOf("submit"))).toContain("view");
  });

  it("keeps saying the account may be open when the view cannot settle it, and offers no plain failure", async () => {
    const h = harness({ submit: () => json(502, { error: "the rollup did not confirm in time" }) });
    const outcome = await h.client.openAccount(h.wallet);
    expect(outcome).toEqual({ kind: "refused", refusal: { kind: "mayBeOpen" } });
    expect(h.events.slice(h.events.indexOf("submit"))).toContain("view");
  });

  it("reads the view when the service says the address already has an account", async () => {
    const h = harness({
      prepare: () => {
        h.setOpen(true);
        return json(409, { error: "this address has an account already. Nothing changed" });
      },
    });
    expect(await h.client.openAccount(h.wallet)).toEqual({ kind: "alreadyOpen" });
    expect(h.events.slice(h.events.indexOf("prepare"))).toContain("view");
  });

  it("does not take the service's word that an account exists when the view shows none", async () => {
    const h = harness({
      prepare: () => json(409, { error: "this address has an account already. Nothing changed" }),
    });
    expect(await h.client.openAccount(h.wallet)).toEqual({
      kind: "refused",
      refusal: { kind: "mayBeOpen" },
    });
  });
});

describe("test funds on a mainnet build", () => {
  it("are not offered, and ask neither the service nor the network", async () => {
    const h = harness({});
    expect(await h.client.knownNoFaucet()).toBe(true);
    expect(await h.client.fund(h.wallet)).toEqual({ kind: "noFaucet" });
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.built()).toBe(0);
  });
});

describe("the account status", () => {
  it("is absent only when the view says it is not readable", async () => {
    const h = harness({});
    expect(await h.client.accountStatus(h.wallet)).toBe("absent");
  });

  it("is open when the view reads", async () => {
    const h = harness({ open: true });
    expect(await h.client.accountStatus(h.wallet)).toBe("open");
  });
});
