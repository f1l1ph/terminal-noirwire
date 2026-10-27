import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import {
  retriesSignIn,
  SessionAuthError,
  type RollupSession,
  type TraderClientLike,
} from "@/lib/rollup/session";
import { NetworkRefused } from "@/lib/rollup/networkCheck";
import { StaleSigner } from "@/lib/wallet/ownerSigner";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { View } from "@/lib/rollup/sdk";
import type { WalletIdentity } from "@/lib/trading/types";

const VIEW = {
  orderKeys: [],
  resultsWritten: 0,
  results: [],
  snapshot: {
    seat: { collateral: 0n, spot: [], perp: [], openOrders: [] },
    marketId: 0,
    orders: [],
  },
} as unknown as View;

const DEPLOYMENT = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
} as PublicDeployment;

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

function harness(failures: unknown[], viewFailures: unknown[] = []) {
  let builds = 0;
  let closed = 0;
  const removed: string[] = [];
  const unused = async () => {
    throw new Error("unused");
  };
  const client = {
    view: async () => {
      const failure = viewFailures.shift();
      if (failure) throw failure;
      return VIEW;
    },
    subscribeView: () => async () => {},
    placeOrder: unused,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  } as unknown as TraderClientLike;
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: () => undefined,
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: (key: string) => void removed.push(key),
    },
    buildSession: async () => {
      builds += 1;
      await Promise.resolve();
      const failure = failures.shift();
      if (failure) throw failure;
      const session: RollupSession = {
        owner: keypairOwnerSigner(Keypair.generate()),
        orderKeyPublicKeys: [],
        client,
        deployment: DEPLOYMENT,
        tokenIndexBySymbol: new Map(),
        collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
        gate: Keypair.generate().publicKey,
        tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
        saveKeyCheckpoint: () => {},
        close: () => {
          closed += 1;
        },
      };
      return session;
    },
  });
  return { rollup, builds: () => builds, closed: () => closed, removed };
}

describe("one sign-in at a time per owner", () => {
  it("shares a single rebuild between callers that all found the session unusable", async () => {
    const { rollup, builds } = harness([new SessionAuthError(new Error("401 Missing token"))]);
    const statuses = await Promise.all([
      rollup.accountStatus(WALLET),
      rollup.accountStatus(WALLET),
      rollup.accountStatus(WALLET),
    ]);
    expect(statuses).toEqual(["open", "open", "open"]);
    expect(builds()).toBe(2);
  });

  it("does not retry after the owner refused the wallet prompt, and the next action may try", async () => {
    const refusal = () => new SessionAuthError(new Error("User rejected the request"));
    const { rollup, builds } = harness([refusal()]);
    const first = await Promise.all([rollup.accountStatus(WALLET), rollup.accountStatus(WALLET)]);
    expect(first).toEqual(["declined", "declined"]);
    expect(builds()).toBe(1);
    expect(await rollup.accountStatus(WALLET)).toBe("open");
    expect(builds()).toBe(2);
  });

  it("reports a failed sign-in that was not a decline as unknown, not declined", async () => {
    const failing = harness([
      new SessionAuthError(new Error("boom")),
      new SessionAuthError(new Error("boom")),
    ]);
    expect(await failing.rollup.accountStatus(WALLET)).toBe("unknown");
  });

  it("clears the sign-in token and starts a new session when the rollup refuses it mid-session", async () => {
    // The first view read belongs to the session's own background watch.
    const { rollup, builds, removed } = harness(
      [],
      [null, new Error("401 Missing token query param")],
    );
    expect(await rollup.accountStatus(WALLET)).toBe("unknown");
    expect(removed.some((key) => key.includes("owner-address"))).toBe(true);
    expect(builds()).toBe(2);
    expect(await rollup.accountStatus(WALLET)).toBe("open");
    expect(builds()).toBe(2);
  });

  it("signs in on its own at most once when every token it gets is refused, then waits for the owner", async () => {
    const refusals = Array.from({ length: 20 }, () => new Error("401 Missing token query param"));
    const { rollup, builds } = harness([], [null, ...refusals]);
    const stopped: boolean[] = [];
    rollup.subscribeSessionStopped(WALLET, (value) => stopped.push(value));
    // The stale-margin timer reads the account every few seconds.
    const errors: unknown[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      await rollup.fetchState(WALLET).catch((error: unknown) => errors.push(error));
    }
    expect(builds()).toBe(2);
    expect(stopped).toEqual([false, true]);
    const last = errors.at(-1);
    expect(last).toBeInstanceOf(Error);
    expect((last as Error).name).toBe("SessionRefused");
    expect((last as Error).message).toBe(
      "The exchange stopped accepting your sign-in. Sign in again to continue.",
    );

    await rollup.signInAgain(WALLET);
    expect(stopped).toEqual([false, true, false]);
    expect(builds()).toBe(3);
  });

  it("does not retry a network refusal or a stale signer", async () => {
    for (const cause of [new NetworkRefused("wrong network"), new StaleSigner()]) {
      const { rollup, builds } = harness([new SessionAuthError(cause)]);
      expect(await rollup.accountStatus(WALLET)).toBe("unknown");
      expect(builds()).toBe(1);
    }
  });

  it("moves an unread account to open when the check is run again", async () => {
    const { rollup } = harness([new SessionAuthError(new Error("User rejected the request"))]);
    expect(await rollup.accountStatus(WALLET)).toBe("declined");
    expect(await rollup.accountStatus(WALLET)).toBe("open");
  });

  it("keeps a session that was still being built when the wallet was closed and reopened", async () => {
    const { rollup, builds, closed } = harness([]);
    const first = rollup.accountStatus(WALLET);
    rollup.closeWallet(WALLET);
    const second = rollup.accountStatus(WALLET);
    expect(await Promise.all([first, second])).toEqual(["open", "open"]);
    expect(builds()).toBe(1);
    expect(closed()).toBe(0);
  });
});

describe("retriesSignIn", () => {
  it("retries only failures that are neither a refusal nor a stale or refused signer", () => {
    expect(retriesSignIn(new Error("401 Missing token query param"))).toBe(true);
    expect(retriesSignIn(new Error("User rejected the request"))).toBe(false);
    expect(retriesSignIn(Object.assign(new Error("x"), { code: 4001 }))).toBe(false);
    expect(retriesSignIn(new NetworkRefused("r"))).toBe(false);
    expect(retriesSignIn(new StaleSigner())).toBe(false);
  });
});
