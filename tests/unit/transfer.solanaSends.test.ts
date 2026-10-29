import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  MAX_MICRO_LAMPORTS_PER_UNIT,
  MICRO_LAMPORTS_PER_UNIT,
  MIN_COMPUTE_UNITS,
  computeUnitLimitOf,
  computeUnitPriceOf,
  computeUnitsAfterSimulation,
  computeUnitsFor,
  microLamportsFromFees,
} from "@/lib/transfer/computeBudget";
import { deposit } from "@/lib/transfer/deposit";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { confirmSignature, type SolanaRpc } from "@/lib/transfer/solanaRpc";
import { makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const ask = (world: World, intent: Parameters<typeof deposit>[1]["intent"] = { kind: "new" }) =>
  deposit(world.env, { amount: "2.5", intent });

describe("confirmSignature", () => {
  const clock = () => ({
    t: 0,
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      this.t += ms;
    },
  });

  it("reads the block height before the status, so a transaction landing between them is never judged expired", async () => {
    let landed = false;
    const rpc = {
      getBlockHeight: async () => {
        landed = true;
        return 1_001;
      },
      getSignatureStatuses: async () => ({
        value: [landed ? { err: null, confirmationStatus: "confirmed" } : null],
      }),
    } as unknown as SolanaRpc;
    const result = await confirmSignature(rpc, "sig", {
      clock: clock(),
      timeoutMs: 10_000,
      lastValidBlockHeight: 1_000,
    });
    expect(result).toEqual({ state: "confirmed", seen: "confirmed" });
  });

  it("still reports a transaction that never showed once the height is past", async () => {
    const rpc = {
      getBlockHeight: async () => 1_001,
      getSignatureStatuses: async () => ({ value: [null] }),
    } as unknown as SolanaRpc;
    expect(
      await confirmSignature(rpc, "sig", {
        clock: clock(),
        timeoutMs: 10_000,
        lastValidBlockHeight: 1_000,
      }),
    ).toEqual({ state: "expired", seen: undefined });
  });

  it("rebroadcasts with the same preflight commitment as the first send", async () => {
    const options: unknown[] = [];
    const rpc = {
      getBlockHeight: async () => 1,
      getSignatureStatuses: async () => ({ value: [null] }),
      sendRawTransaction: async (_raw: Uint8Array, given: unknown) => {
        options.push(given);
        return "sig";
      },
    } as unknown as SolanaRpc;
    await confirmSignature(rpc, "sig", {
      clock: clock(),
      timeoutMs: 9_000,
      lastValidBlockHeight: 1_000,
      rebroadcast: new Uint8Array(1),
    });
    expect(options.length).toBeGreaterThan(0);
    for (const given of options) {
      expect(given).toEqual({ skipPreflight: true, preflightCommitment: "confirmed" });
    }
  });

  it("sends the first transfer broadcast with preflight at confirmed", async () => {
    const world = makeWorld();
    const given: unknown[] = [];
    const send = world.solana.sendRawTransaction.bind(world.solana);
    world.solana.sendRawTransaction = async (raw, options) => {
      given.push(options);
      return send(raw);
    };
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    await ask(world);
    expect(given).toEqual([
      { preflightCommitment: "confirmed" },
      { preflightCommitment: "confirmed" },
    ]);
  });
});

describe("a Solana send that was seen and then dropped", () => {
  /** A node that shows the first send as `status` once it is broadcast, with the confirmed and finalized heights it is given. */
  function seenAs(status: string) {
    const world = makeWorld();
    const heights = { confirmed: world.solana.height, finalized: world.solana.height };
    const send = world.solana.sendRawTransaction.bind(world.solana);
    world.solana.sendRawTransaction = async (raw) => {
      const signature = await send(raw);
      world.solana.statuses.set(signature, { err: null, confirmationStatus: status });
      return signature;
    };
    world.solana.script({ fate: "swallow" });
    world.solana.getBlockHeight = async (commitment?: string) =>
      commitment === "finalized" ? heights.finalized : heights.confirmed;
    return { world, heights };
  }

  it("is decided from the finalized chain without an operator answer, and never while it may still land", async () => {
    const { world, heights } = seenAs("processed");
    const first = await ask(world);
    expect(first).toMatchObject({ status: "waiting" });
    const record = world.record()!;
    const signature = record.sends[0].signature;
    expect(record.sends[0].status).toBe("processed");
    world.solana.statuses.delete(signature);
    const resume = () => ask(world, { kind: "resume", id: record.id, atoms: record.atoms });

    expect(await resume()).toMatchObject({ status: "waiting" });
    heights.confirmed = record.sends[0].lastValidBlockHeight + 1;
    expect(await resume()).toMatchObject({ status: "waiting" });
    expect(world.record()).toBeDefined();

    heights.finalized = record.sends[0].lastValidBlockHeight + 1;
    const settled = await resume();
    expect(settled).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(0);
    expect(new Set(world.solana.sent).size).toBe(1);
  });

  it("is taken as landed if it shows up on the finalized chain after all", async () => {
    const { world, heights } = seenAs("processed");
    await ask(world);
    const record = world.record()!;
    const signature = record.sends[0].signature;
    heights.confirmed = heights.finalized = record.sends[0].lastValidBlockHeight + 1;
    world.solana.statuses.set(signature, { err: null, confirmationStatus: "finalized" });
    world.fundEffect(ATOMS)();
    const seenSend = world.solana.sendRawTransaction.bind(world.solana);
    world.solana.sendRawTransaction = async (raw, options) => {
      const sent = await seenSend(raw, options);
      world.solana.statuses.set(sent, { err: null, confirmationStatus: "finalized" });
      return sent;
    };
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await ask(world, { kind: "resume", id: record.id, atoms: record.atoms })).toMatchObject({
      status: "done",
    });
    expect(world.solana.sent[0]).toBe(signature);
    expect(world.solana.sent).toHaveLength(2);
  });

  it("does not show internal wording while it is waited on", async () => {
    const { world } = seenAs("processed");
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting" });
    expect(JSON.stringify(outcome)).not.toMatch(/seen as processed/);
    expect(outcomeLine("deposit", outcome, 6, 1).text).toContain("still settling");
  });
});

describe("a Solana send that failed at confirmed", () => {
  const failure = { InstructionError: [2, { Custom: 1 }] };

  it("waits while the failure may be rolled back, and is then a clear failure rather than unknown", async () => {
    const world = makeWorld();
    const send = world.solana.sendRawTransaction.bind(world.solana);
    world.solana.sendRawTransaction = async (raw) => {
      const signature = await send(raw);
      world.solana.statuses.set(signature, { err: failure, confirmationStatus: "confirmed" });
      return signature;
    };
    world.solana.script({ fate: "swallow" });
    const first = await ask(world);
    expect(first).toMatchObject({ status: "waiting" });
    expect(first.status === "waiting" && first.message).not.toMatch(/processed|answered/);
    const record = world.record()!;
    const signature = record.sends[0].signature;
    world.solana.statuses.set(signature, { err: failure, confirmationStatus: "finalized" });
    const final = await ask(world, { kind: "resume", id: record.id, atoms: record.atoms });
    expect(final).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(outcomeLine("deposit", final, 6, 1).text).toBe(
      "The transaction did not go through and can no longer. Nothing moved. You can start again.",
    );
    expect(world.rows.size).toBe(0);
  });
});

describe("the compute budget of a Solana send", () => {
  const budgetOf = (world: World) => {
    const [limit, price] = world.signed[0].instructions;
    return { units: computeUnitLimitOf(limit), price: computeUnitPriceOf(price) };
  };
  const run = async (world: World) => {
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await ask(world)).toMatchObject({ status: "done" });
  };

  it("sets the unit limit to the simulated units plus 10%", async () => {
    const world = makeWorld();
    world.solana.unitsConsumed = 100_000;
    await run(world);
    expect(budgetOf(world).units).toBe(110_000);
  });

  it("simulates with the full allowance, then signs the measured limit", async () => {
    const world = makeWorld();
    world.solana.unitsConsumed = 100_000;
    await run(world);
    expect(computeUnitLimitOf(world.solana.simulated[0].instructions[0])).toBeGreaterThan(110_000);
  });

  it("keeps today's limit when the node reports no units", async () => {
    const world = makeWorld();
    await run(world);
    const count = world.signed[0].instructions.length - 2;
    expect(budgetOf(world).units).toBe(computeUnitsFor(count));
  });

  it("never signs a limit below the floor or above today's allowance", () => {
    expect(computeUnitsAfterSimulation(4, 1_000)).toBe(MIN_COMPUTE_UNITS);
    expect(computeUnitsAfterSimulation(4, 10_000_000)).toBe(computeUnitsFor(4));
    expect(computeUnitsAfterSimulation(4, 0)).toBe(computeUnitsFor(4));
    expect(computeUnitsAfterSimulation(4, Number.NaN)).toBe(computeUnitsFor(4));
    expect(computeUnitsAfterSimulation(4, 300_000)).toBe(330_000);
  });

  it("follows the 75th percentile of the recent fees, asked for the accounts the transaction writes", async () => {
    const world = makeWorld();
    world.solana.recentFees = Array.from({ length: 100 }, (_, at) => (at + 1) * 1_000);
    await run(world);
    expect(budgetOf(world).price).toBe(75_000);
    const written = world.solana.rawSent
      .flatMap((raw) => Transaction.from(raw).instructions)
      .flatMap((instruction) => instruction.keys)
      .filter((key) => key.isWritable)
      .map((key) => key.pubkey.toBase58());
    expect(world.solana.feeAccounts.length).toBeGreaterThan(0);
    for (const account of world.solana.feeAccounts) {
      expect(written).toContain(account.toBase58());
    }
    expect(new Set(world.solana.feeAccounts.map((key) => key.toBase58())).size).toBe(
      world.solana.feeAccounts.length,
    );
  });

  it("never pays less than today's price, however quiet the network is", async () => {
    const world = makeWorld();
    world.solana.recentFees = [0, 0, 5];
    await run(world);
    expect(budgetOf(world).price).toBe(MICRO_LAMPORTS_PER_UNIT);
  });

  it("never pays more than the cap, however busy the network is", async () => {
    const world = makeWorld();
    world.solana.recentFees = [10_000_000, 20_000_000];
    await run(world);
    expect(budgetOf(world).price).toBe(MAX_MICRO_LAMPORTS_PER_UNIT);
  });

  it("falls back to today's price when the fee read fails or says nothing", async () => {
    for (const fees of [new Error("429"), []]) {
      const world = makeWorld();
      world.solana.recentFees = fees;
      await run(world);
      expect(budgetOf(world).price).toBe(MICRO_LAMPORTS_PER_UNIT);
    }
  });

  it("ranks fees by percentile", () => {
    expect(microLamportsFromFees(undefined)).toBe(MICRO_LAMPORTS_PER_UNIT);
    expect(microLamportsFromFees([])).toBe(MICRO_LAMPORTS_PER_UNIT);
    expect(microLamportsFromFees([100_000])).toBe(100_000);
    expect(microLamportsFromFees([60_000, 70_000, 80_000, 90_000])).toBe(80_000);
    expect(microLamportsFromFees([Number.NaN, -1])).toBe(MICRO_LAMPORTS_PER_UNIT);
  });

  it("is signed through the guard with both measured values", async () => {
    const world = makeWorld();
    world.solana.unitsConsumed = 60_000;
    world.solana.recentFees = [120_000];
    await run(world);
    expect(budgetOf(world)).toEqual({ units: 66_000, price: 120_000 });
    expect(world.signed).toHaveLength(1);
  });
});
