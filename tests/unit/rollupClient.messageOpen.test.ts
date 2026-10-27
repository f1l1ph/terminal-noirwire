import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import {
  deploymentSchema,
  usesOwnerMessages,
  type PublicDeployment,
} from "@/lib/rollup/deployment";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import { ownerActionText, VIEW_NOT_READABLE_MESSAGE } from "@/lib/rollup/sdk";
import type { WalletIdentity } from "@/lib/trading/types";

const PROGRAM = new PublicKey(MAINNET_PINS.programId);
const OWNER = Keypair.generate();
const ORDER_KEYS = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const NOW = 1_800_000_000_000;
const EXPIRES_AT = NOW / 1000 + 100;
const SIM = "https://sim.example";

const deployment = (ownerAuth?: "message" | "transaction"): PublicDeployment => ({
  network: "mainnet",
  programId: MAINNET_PINS.programId,
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  rollupRpcUrl: MAINNET_PINS.rollupRpcUrl,
  rollupWsUrl: MAINNET_PINS.rollupWsUrl,
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
  ...(ownerAuth ? { ownerAuth } : {}),
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

function harness(
  options: {
    prepare?: () => Response;
    signMessage?: OwnerSigner["signMessage"];
  } = {},
) {
  const events: string[] = [];
  const real = keypairOwnerSigner(OWNER);
  const signMessage = vi.fn(options.signMessage ?? real.signMessage);
  const signTransaction = vi.fn(async (tx: Transaction) => real.signTransaction(tx));
  const signer: OwnerSigner = { publicKey: OWNER.publicKey, signMessage, signTransaction };
  const submitted: unknown[] = [];

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/open/prepare")) {
      events.push("prepare");
      return (
        options.prepare?.() ?? json(200, { expiresAt: EXPIRES_AT, expiresAtMs: EXPIRES_AT * 1000 })
      );
    }
    if (url.endsWith("/v1/open/submit")) {
      events.push("submit");
      submitted.push(JSON.parse(String(init?.body)));
      return json(200, { reference: "sig-open" });
    }
    throw new Error(`unexpected request ${url}`);
  });

  const session = (): RollupSession => ({
    owner: signer,
    orderKeyPublicKeys: ORDER_KEYS.map((key) => key.toBase58()),
    client: {
      view: async () => {
        throw new Error(VIEW_NOT_READABLE_MESSAGE);
      },
      subscribeView: () => async () => {},
    } as unknown as TraderClientLike,
    deployment: deployment("message"),
    tokenIndexBySymbol: new Map(),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
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
    buildSession: async () => session(),
  });
  const wallet: WalletIdentity = { address: OWNER.publicKey.toBase58(), signer };
  return { client, wallet, events, signMessage, signTransaction, submitted, fetchFn };
}

describe("the deployment's ownerAuth", () => {
  it("is the transaction path unless the description says message", () => {
    expect(usesOwnerMessages(deployment())).toBe(false);
    expect(usesOwnerMessages(deployment("transaction"))).toBe(false);
    expect(usesOwnerMessages(deployment("message"))).toBe(true);
  });

  it("is read from the description and refused when it is neither word", () => {
    const base = deployment();
    expect(deploymentSchema.parse(base).ownerAuth).toBeUndefined();
    expect(deploymentSchema.parse({ ...base, ownerAuth: "message" }).ownerAuth).toBe("message");
    expect(deploymentSchema.safeParse({ ...base, ownerAuth: "signature" }).success).toBe(false);
  });
});

describe("opening an account by a signed message", () => {
  it("builds the message itself, has the wallet sign it once and submits the signature with the expiry", async () => {
    const h = harness();
    const outcome = await h.client.openAccount(h.wallet, "invite-code");
    expect(outcome).toEqual({ kind: "opened", reference: "sig-open" });
    const message = ownerActionText(
      "open",
      PROGRAM,
      OWNER.publicKey,
      ORDER_KEYS,
      BigInt(EXPIRES_AT),
    );
    expect(h.signMessage).toHaveBeenCalledTimes(1);
    expect(h.signMessage.mock.calls[0][0]).toEqual(message);
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.submitted).toHaveLength(1);
    const body = h.submitted[0] as { owner: string; signature: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "owner", "signature"]);
    expect(body.owner).toBe(OWNER.publicKey.toBase58());
    expect(body.expiresAt).toBe(EXPIRES_AT);
    const signature = Buffer.from(body.signature, "base64");
    expect(signature).toHaveLength(64);
    expect(nacl.sign.detached.verify(message, signature, OWNER.publicKey.toBytes())).toBe(true);
  });

  it("ignores any transaction or message text the service adds to its answer", async () => {
    const h = harness({
      prepare: () =>
        json(200, {
          expiresAt: EXPIRES_AT,
          expiresAtMs: EXPIRES_AT * 1000,
          message: Buffer.from("send all funds").toString("base64"),
          transaction: "AAAA",
        }),
    });
    expect((await h.client.openAccount(h.wallet)).kind).toBe("opened");
    const signed = h.signMessage.mock.calls[0][0];
    expect(Buffer.from(signed).toString()).not.toContain("send all funds");
    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("reports a declined message as nothing sent", async () => {
    const h = harness({
      signMessage: async () => {
        throw new Error("User rejected the request");
      },
    });
    expect(await h.client.openAccount(h.wallet)).toEqual({
      kind: "notSent",
      reason: "You declined the message",
    });
    expect(h.events).not.toContain("submit");
    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("does not ask the wallet when the prepared expiry is about to lapse or is too far ahead", async () => {
    for (const expiresAt of [EXPIRES_AT - 95, EXPIRES_AT + 60]) {
      const h = harness({
        prepare: () => json(200, { expiresAt, expiresAtMs: expiresAt * 1000 }),
      });
      expect((await h.client.openAccount(h.wallet)).kind).toBe("notSent");
      expect(h.signMessage).not.toHaveBeenCalled();
      expect(h.events).not.toContain("submit");
    }
  });

  it("treats an answer carrying only a transaction as the other mode, signing nothing", async () => {
    const h = harness({
      prepare: () => json(200, { transaction: "AAAA", expiresAtMs: NOW + 45_000 }),
    });
    expect((await h.client.openAccount(h.wallet)).kind).toBe("notSent");
    expect(h.signMessage).not.toHaveBeenCalled();
    expect(h.signTransaction).not.toHaveBeenCalled();
  });
});
