import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import {
  ALL_KEYS_BUSY_MESSAGE,
  freshOrderKeys,
  KEYS_NOT_FROM_SEED_MESSAGE,
  orderKeysFromCheckpoint,
  PACKAGE_PROGRAM_ID,
  TraderClient,
  VIEW_NOT_READABLE_MESSAGE,
} from "@/lib/rollup/sdk";

/**
 * The session and outcome mapping recognise three of the package's errors
 * by their exact text. Each is raised here by the installed package itself,
 * not by a fake, so a release that rewords one fails this test instead of
 * silently turning "no account yet" into a failed sign-in.
 */

const seed = new Uint8Array(32).fill(7);
const thrownBy = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "did not throw";
};

describe("the package's own error texts", () => {
  it("a view that does not exist yet", async () => {
    const noAccounts = { getAccountInfo: async () => null } as unknown as Connection;
    const client = new TraderClient(
      noAccounts,
      noAccounts,
      Keypair.generate().publicKey,
      freshOrderKeys(seed),
      PACKAGE_PROGRAM_ID,
      { push: false },
    );
    expect(await thrownBy(() => client.view())).toBe(VIEW_NOT_READABLE_MESSAGE);
  });

  it("every order key already lent out", async () => {
    const keys = freshOrderKeys(seed);
    for (let slot = 0; slot < 4; slot += 1) keys.take();
    expect(await thrownBy(() => keys.take())).toBe(ALL_KEYS_BUSY_MESSAGE);
  });

  it("a view holding keys this seed never derived", async () => {
    const strangers = { orderKeys: [0, 1, 2, 3].map(() => Keypair.generate().publicKey) };
    expect(await thrownBy(() => orderKeysFromCheckpoint(seed, strangers, null, 8))).toBe(
      KEYS_NOT_FROM_SEED_MESSAGE,
    );
  });
});
