import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import { WithdrawalUnknown } from "@/lib/rollup/sdk";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { WalletIdentity } from "@/lib/trading/types";
import { NotDispatched } from "@/lib/transfer/keyedWithdrawal";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { signedAttempt } from "./transferWorld";

const PROGRAM = Keypair.generate().publicKey;
const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

const DEPLOYMENT = {
  network: "localnet",
  programId: PROGRAM.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [],
} as unknown as PublicDeployment;

/** A rollup connection that records what it was asked to broadcast. */
function connection() {
  const sent: Uint8Array[] = [];
  const reader = {
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return "signature";
    },
  };
  return { reader: reader as unknown as Connection, sent, original: reader.sendRawTransaction };
}

/** A client whose withdrawal is `run`, given the connection the session was built on. */
function clientTrading(
  sessions: Array<{ reader: Connection | undefined; tokenExpiresAtMs?: number }>,
  run: (reader: Connection | undefined) => Promise<unknown>,
) {
  let built = 0;
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: () => undefined,
    storage,
    buildSession: async () => {
      const made = sessions[Math.min(built++, sessions.length - 1)];
      const client = {
        view: async () => {
          throw new Error("unused");
        },
        withdrawByKey: async () => run(made.reader),
      } as unknown as TraderClientLike;
      const session: RollupSession = {
        owner: keypairOwnerSigner(Keypair.generate()),
        orderKeyPublicKeys: [],
        client,
        deployment: DEPLOYMENT,
        tokenIndexBySymbol: new Map(),
        reader: made.reader,
        collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
        gate: Keypair.generate().publicKey,
        tokenExpiresAtMs: made.tokenExpiresAtMs ?? Number.MAX_SAFE_INTEGER,
        saveKeyCheckpoint: () => {},
        close: () => {},
      };
      return session;
    },
  });
}

const dispatchWithdrawal = (reader: Connection | undefined, call = 1) =>
  reader!.sendRawTransaction(signedAttempt(call, PROGRAM), { skipPreflight: true });

describe("the order key withdrawal's pre-send hook", () => {
  it("hands the signed bytes over before the session's own connection dispatches them", async () => {
    const wire = connection();
    const order: string[] = [];
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      await dispatchWithdrawal(reader);
      return {};
    });
    const result = await trading.withdrawByKey(WALLET, 1n, async () => {
      order.push(wire.sent.length === 0 ? "recorded" : "late");
    });
    expect(result).toEqual({ kind: "withdrawn" });
    expect(order).toEqual(["recorded"]);
    expect(wire.sent).toHaveLength(1);
    expect(wire.reader.sendRawTransaction).toBe(wire.original);
  });

  it("is installed on the connection of the session that makes the call, even when the session was just replaced", async () => {
    const first = connection();
    const second = connection();
    const hooked: string[] = [];
    const trading = clientTrading(
      [{ reader: first.reader, tokenExpiresAtMs: 0 }, { reader: second.reader }],
      async (reader) => {
        await dispatchWithdrawal(reader);
        return {};
      },
    );
    await trading.withdrawByKey(WALLET, 1n, async () => void hooked.push("signed"));
    expect(hooked).toEqual(["signed"]);
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
    expect(first.reader.sendRawTransaction).toBe(first.original);
    expect(second.reader.sendRawTransaction).toBe(second.original);
  });

  it("leaves other transactions of the same connection alone", async () => {
    const wire = connection();
    const hooked: unknown[] = [];
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      await reader!.sendRawTransaction(new Uint8Array(3), {});
      return {};
    });
    await trading.withdrawByKey(WALLET, 1n, async (raw) => void hooked.push(raw));
    expect(hooked).toEqual([]);
    expect(wire.sent).toHaveLength(1);
  });

  it("calls a journaling failure before the real send NotDispatched, whatever the client then throws", async () => {
    const wire = connection();
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      try {
        await dispatchWithdrawal(reader);
      } catch {
        throw new Error("view read failed");
      }
      return {};
    });
    const error = await trading
      .withdrawByKey(WALLET, 1n, async () => {
        throw new Error("IndexedDB write rejected");
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotDispatched);
    expect(wire.sent).toEqual([]);
    expect(wire.reader.sendRawTransaction).toBe(wire.original);
  });

  it("calls an unproven outcome NotDispatched when nothing was dispatched", async () => {
    const wire = connection();
    const trading = clientTrading([{ reader: wire.reader }], async () => {
      throw new WithdrawalUnknown(Promise.resolve(null));
    });
    const error = await trading.withdrawByKey(WALLET, 1n, async () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotDispatched);
  });

  it("keeps the client's own answer for an unproven outcome once something was dispatched", async () => {
    const wire = connection();
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      await dispatchWithdrawal(reader);
      throw new WithdrawalUnknown(Promise.resolve(null));
    });
    expect(await trading.withdrawByKey(WALLET, 1n, async () => {})).toEqual({
      kind: "didNotRun",
    });
  });

  it("rethrows what the client threw after a dispatch, unchanged, and still gives the connection back", async () => {
    const wire = connection();
    const boom = new Error("socket closed");
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      await dispatchWithdrawal(reader);
      throw boom;
    });
    await expect(trading.withdrawByKey(WALLET, 1n, async () => {})).rejects.toBe(boom);
    expect(wire.reader.sendRawTransaction).toBe(wire.original);
  });

  it("does not run the withdrawal on a connection it cannot watch", async () => {
    let ran = false;
    const trading = clientTrading([{ reader: undefined }], async () => {
      ran = true;
      return {};
    });
    const error = await trading.withdrawByKey(WALLET, 1n, async () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotDispatched);
    expect(ran).toBe(false);
  });

  it("sends nothing from a second call that overlaps the first, and leaves the connection original", async () => {
    const wire = connection();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      calls += 1;
      await gate;
      await dispatchWithdrawal(reader, calls);
      return {};
    });
    const first = trading.withdrawByKey(WALLET, 1n, async () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await trading.withdrawByKey(WALLET, 1n, async () => {}).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(NotDispatched);
    release();
    expect(await first).toEqual({ kind: "withdrawn" });
    expect(calls).toBe(1);
    expect(wire.sent).toHaveLength(1);
    expect(wire.reader.sendRawTransaction).toBe(wire.original);
  });

  it("is not involved when no hook is asked for", async () => {
    const wire = connection();
    const trading = clientTrading([{ reader: wire.reader }], async (reader) => {
      await dispatchWithdrawal(reader);
      return {};
    });
    expect(await trading.withdrawByKey(WALLET, 1n)).toEqual({ kind: "withdrawn" });
    expect(wire.reader.sendRawTransaction).toBe(wire.original);
  });
});
