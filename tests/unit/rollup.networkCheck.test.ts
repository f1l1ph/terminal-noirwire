import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  guardedOwnerSigner,
  NetworkRefused,
  rpcIdentity,
  stillTheNetwork,
  type NetworkReads,
} from "@/lib/rollup/networkCheck";
import type { OwnerSigner } from "@/lib/wallet/ownerSigner";

const expected = { genesis: "GenesisAaa111", validator: "VndrAbc111" };

const reads = (overrides: Partial<{ genesis: string; validator: string }> = {}): NetworkReads => ({
  solana: { getGenesisHash: async () => overrides.genesis ?? expected.genesis },
  rollupIdentity: async () => overrides.validator ?? expected.validator,
});

describe("stillTheNetwork", () => {
  it("passes when genesis and validator are both the expected ones", async () => {
    expect(await stillTheNetwork(reads(), expected)).toBeNull();
  });

  it("refuses a different genesis hash", async () => {
    expect(await stillTheNetwork(reads({ genesis: "GenesisBbb111" }), expected)).not.toBeNull();
  });

  it("refuses a different rollup validator", async () => {
    expect(await stillTheNetwork(reads({ validator: "VndrBcd111" }), expected)).not.toBeNull();
  });

  it("refuses when the Solana read fails", async () => {
    const failing: NetworkReads = {
      ...reads(),
      solana: {
        getGenesisHash: async () => {
          throw new Error("offline");
        },
      },
    };
    expect(await stillTheNetwork(failing, expected)).not.toBeNull();
  });

  it("refuses when the rollup identity read fails", async () => {
    const failing: NetworkReads = {
      ...reads(),
      rollupIdentity: async () => {
        throw new Error("offline");
      },
    };
    expect(await stillTheNetwork(failing, expected)).not.toBeNull();
  });

  it.each([
    ["an empty genesis", { genesis: "", validator: expected.validator }],
    ["an empty validator", { genesis: expected.genesis, validator: "" }],
    ["a genesis that is not base58", { genesis: "gen0-a", validator: expected.validator }],
  ])("refuses %s before any read", async (_name, bad) => {
    let calls = 0;
    const counting: NetworkReads = {
      solana: {
        getGenesisHash: async () => {
          calls += 1;
          return bad.genesis;
        },
      },
      rollupIdentity: async () => {
        calls += 1;
        return bad.validator;
      },
    };
    expect(await stillTheNetwork(counting, bad)).not.toBeNull();
    expect(calls).toBe(0);
  });
});

describe("guardedOwnerSigner", () => {
  const countingSigner = () => {
    const asked = { count: 0 };
    const keypair = Keypair.generate();
    const signer: OwnerSigner = {
      publicKey: keypair.publicKey,
      signMessage: async (m) => {
        asked.count += 1;
        return m;
      },
      signTransaction: async (tx) => {
        asked.count += 1;
        return tx;
      },
    };
    return { signer, asked };
  };

  it("never asks the wallet to sign a message when the network check fails", async () => {
    const { signer, asked } = countingSigner();
    const guarded = guardedOwnerSigner(signer, expected, reads({ genesis: "GenesisBbb111" }));
    await expect(guarded.signMessage(new Uint8Array(1))).rejects.toThrow(NetworkRefused);
    expect(asked.count).toBe(0);
  });

  it("never asks the wallet to sign a transaction when the network check fails", async () => {
    const { signer, asked } = countingSigner();
    const guarded = guardedOwnerSigner(signer, expected, reads({ validator: "VndrBcd111" }));
    await expect(guarded.signTransaction(new Transaction())).rejects.toThrow(NetworkRefused);
    expect(asked.count).toBe(0);
  });

  it("asks the wallet once the network is the pinned one", async () => {
    const { signer, asked } = countingSigner();
    const guarded = guardedOwnerSigner(signer, expected, reads());
    await guarded.signMessage(new Uint8Array(1));
    await guarded.signTransaction(new Transaction());
    expect(asked.count).toBe(2);
  });
});

const answering = (init: { status?: number; body: unknown }) =>
  (async () =>
    new Response(JSON.stringify(init.body), { status: init.status ?? 200 })) as typeof fetch;

describe("rpcIdentity", () => {
  it("returns the identity of a good answer", async () => {
    const read = rpcIdentity(
      "https://rollup.test",
      answering({ body: { result: { identity: "Abc" } } }),
    );
    expect(await read()).toBe("Abc");
  });

  it("rejects a non-200 answer", async () => {
    const read = rpcIdentity("https://rollup.test", answering({ status: 503, body: {} }));
    await expect(read()).rejects.toThrow();
  });

  it("rejects a null body", async () => {
    const read = rpcIdentity("https://rollup.test", answering({ body: null }));
    await expect(read()).rejects.toThrow();
  });

  it("rejects a JSON-RPC error", async () => {
    const read = rpcIdentity(
      "https://rollup.test",
      answering({ body: { error: { code: -32601, message: "no" } } }),
    );
    await expect(read()).rejects.toThrow();
  });

  it("rejects a result whose identity is not a string", async () => {
    const read = rpcIdentity(
      "https://rollup.test",
      answering({ body: { result: { identity: 7 } } }),
    );
    await expect(read()).rejects.toThrow();
  });
});
