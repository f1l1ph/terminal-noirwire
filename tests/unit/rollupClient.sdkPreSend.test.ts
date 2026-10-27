import { describe, expect, it } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { freshOrderKeys, OutcomeUnknown, TraderClient } from "@/lib/rollup/sdk";

/**
 * The terminal holds a market only for what the package wraps in
 * `OutcomeUnknown` (thrown after its send begins). This pins the other half
 * of that contract against the installed package: a failure while it checks
 * the market, before it signs, is a plain error and nothing is sent.
 */
describe("the package's pre-send failures", () => {
  it("throw a plain error, and send nothing, when the market cannot be read", async () => {
    let sent = 0;
    const connection = {
      getAccountInfo: async () => {
        throw new Error("fetch failed");
      },
      sendRawTransaction: async () => {
        sent += 1;
        return "signature";
      },
    } as unknown as Connection;
    const client = new TraderClient(
      connection,
      connection,
      Keypair.generate().publicKey,
      freshOrderKeys(new Uint8Array(32).fill(7)),
      Keypair.generate().publicKey,
      { push: false },
    );
    const failure = await client
      .placeOrder(0, {
        side: 0,
        orderType: 0,
        price: 100n,
        size: 1n,
        reduceOnly: false,
        secret: new Uint8Array(16),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OutcomeUnknown);
    expect((failure as Error).message).toBe("fetch failed");
    expect(sent).toBe(0);
  });
});
