import { describe, expect, it } from "vitest";
import { createLimitsReads, type LimitsView } from "@/lib/trading/limitsRead";
import type { MarketLimits } from "@/lib/trading/types";
import { limitsGate } from "@/lib/trading/uiRules";

const limitsWith = (bandBps: number): ReadonlyMap<string, MarketLimits> =>
  new Map([
    [
      "NSOL-PERP",
      {
        imBps: 2000,
        mmBps: 500,
        takerFeeBps: 5,
        bandBps,
        minSize: "0.1",
        minNotional: "5",
        positionCap: "10",
        maxOpenOrders: 32,
      },
    ],
  ]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  let view: LimitsView = { limits: new Map(), limitsState: "loading" };
  const base = createLimitsReads((_owner, next) => {
    view = next;
  });
  const reads = {
    start: (owner: string, read: () => Promise<ReadonlyMap<string, MarketLimits>>) =>
      base.start(owner, read, () => "owner"),
  };
  const gate = () => limitsGate(true, view.limits.get("NSOL-PERP"), view.limitsState);
  return { reads, gate, view: () => view };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("limits are read again for each new session, and orders wait", () => {
  it("pauses orders the moment a new session starts, until its own read lands", async () => {
    const { reads, gate, view } = setup();
    const first = deferred<ReadonlyMap<string, MarketLimits>>();
    reads.start("owner", () => first.promise);
    first.resolve(limitsWith(400));
    await settle();
    expect(gate()).toBeNull();
    expect(view().limits.get("NSOL-PERP")?.bandBps).toBe(400);

    // The session is replaced (a 401 recovery, or the owner signing in again):
    // the chain now states a 200 bps band. The order is tried before the reread lands.
    const reread = deferred<ReadonlyMap<string, MarketLimits>>();
    reads.start("owner", () => reread.promise);
    expect(gate()).toBe("loading");
    expect(view().limits.size).toBe(0);

    reread.resolve(limitsWith(200));
    await settle();
    expect(gate()).toBeNull();
    expect(view().limits.get("NSOL-PERP")?.bandBps).toBe(200);
  });

  it("ignores a late answer from the older session", async () => {
    const { reads, gate, view } = setup();
    const older = deferred<ReadonlyMap<string, MarketLimits>>();
    const newer = deferred<ReadonlyMap<string, MarketLimits>>();
    reads.start("owner", () => older.promise);
    reads.start("owner", () => newer.promise);

    older.resolve(limitsWith(400));
    await settle();
    expect(gate()).toBe("loading");
    expect(view().limits.size).toBe(0);

    newer.resolve(limitsWith(200));
    await settle();
    expect(view().limits.get("NSOL-PERP")?.bandBps).toBe(200);
  });

  it("keeps orders paused when the new session's read fails, with the old limits gone", async () => {
    const { reads, gate, view } = setup();
    const first = deferred<ReadonlyMap<string, MarketLimits>>();
    reads.start("owner", () => first.promise);
    first.resolve(limitsWith(400));
    await settle();

    const reread = deferred<ReadonlyMap<string, MarketLimits>>();
    reads.start("owner", () => reread.promise);
    reread.reject(new Error("401"));
    await settle();
    expect(gate()).toBe("failed");
    expect(view().limits.size).toBe(0);
  });
});
