import { describe, expect, it } from "vitest";
import { assertRollupIdentity, RollupIdentityError } from "@/lib/rollup/identity";

const PINNED = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const URL = "https://rollup.example";

const answering = (response: () => Response) => (async () => response()) as unknown as typeof fetch;

const identityOf = (identity: unknown) => () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { identity } }), { status: 200 });

describe("assertRollupIdentity", () => {
  it("accepts the pinned validator", async () => {
    await expect(
      assertRollupIdentity(URL, PINNED, answering(identityOf(PINNED))),
    ).resolves.toBeUndefined();
  });

  it("refuses another validator", async () => {
    await expect(
      assertRollupIdentity(URL, PINNED, answering(identityOf("11111111111111111111111111111111"))),
    ).rejects.toThrow(/is run by/);
  });

  it("refuses an RPC error answer", async () => {
    const rpcError = () =>
      new Response(JSON.stringify({ error: { code: -32601, message: "no" } }), { status: 200 });
    await expect(assertRollupIdentity(URL, PINNED, answering(rpcError))).rejects.toThrow(
      /gave no identity/,
    );
  });

  it("refuses a malformed answer", async () => {
    await expect(
      assertRollupIdentity(URL, PINNED, answering(identityOf({ nested: true }))),
    ).rejects.toThrow(/gave no identity/);
  });

  it("refuses a body that is not JSON", async () => {
    await expect(
      assertRollupIdentity(
        URL,
        PINNED,
        answering(() => new Response("<html>")),
      ),
    ).rejects.toThrow(RollupIdentityError);
  });

  it("refuses a non-200 answer", async () => {
    await expect(
      assertRollupIdentity(
        URL,
        PINNED,
        answering(() => new Response("{}", { status: 503 })),
      ),
    ).rejects.toThrow(/503/);
  });

  it("refuses when the request itself throws", async () => {
    const failing = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    await expect(assertRollupIdentity(URL, PINNED, failing)).rejects.toThrow(/network down/);
  });
});
