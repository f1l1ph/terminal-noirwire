import { describe, expect, it } from "vitest";
import {
  exitOperation,
  seatVerdict,
  solanaVerdict,
  tokenAtoms,
  type ExitOperation,
  type SeatSend,
  type SolanaSend,
} from "@/lib/transfer/verdicts";

const aSend = (extra: Partial<SolanaSend> = {}): SolanaSend => ({
  signature: "sig",
  lastValidBlockHeight: 1_000,
  ...extra,
});

const nodeAt = (value: { err: unknown; confirmationStatus: string } | null, height = 500) => ({
  getSignatureStatus: async () => ({ value }),
  getBlockHeight: async () => height,
});

const processed = (height = 500) => nodeAt({ err: null, confirmationStatus: "processed" }, height);
const failing = (confirmationStatus: string) =>
  nodeAt({ err: { InstructionError: [0, "x"] }, confirmationStatus }, 1_001);

describe("solanaVerdict", () => {
  it("lands a send the node shows as confirmed", async () => {
    expect(
      await solanaVerdict(nodeAt({ err: null, confirmationStatus: "confirmed" }), aSend()),
    ).toBe("landed");
  });

  it("fails a send finalized with an error", async () => {
    expect(await solanaVerdict(failing("finalized"), aSend())).toBe("failed");
    expect(await solanaVerdict(failing("finalized"), aSend({ everProcessed: true }))).toBe(
      "failed",
    );
  });

  it("waits on an error that is not final, expired or not", async () => {
    for (const status of ["processed", "confirmed"]) {
      expect(await solanaVerdict(failing(status), aSend()), status).toBe("wait");
      const seen = aSend({ everProcessed: true });
      expect(await solanaVerdict(failing(status), seen), status).toBe("wait");
      expect(await solanaVerdict(failing(status), seen, `landed:${seen.signature}`)).toBe("landed");
      expect(seen.everProcessed).toBe(true);
    }
  });

  it("marks a processed send and waits", async () => {
    const seen = aSend();
    expect(await solanaVerdict(processed(), seen)).toBe("wait");
    expect(seen.everProcessed).toBe(true);
  });

  it("never drops a send seen as processed on a later missing status after the blockhash expired", async () => {
    const expired = aSend();
    expect(await solanaVerdict(processed(1_001), expired)).toBe("wait");
    for (const answer of ["lost:other", `lost:${expired.signature}`, undefined]) {
      expect(await solanaVerdict(nodeAt(null, 1_001), expired, answer), String(answer)).toBe(
        "wait",
      );
    }
    expect(await solanaVerdict(nodeAt(null, 1_001), expired, `landed:${expired.signature}`)).toBe(
      "landed",
    );
    expect(
      await solanaVerdict(nodeAt({ err: null, confirmationStatus: "confirmed" }, 1_001), expired),
    ).toBe("landed");
  });

  it("waits on a never-seen send while its blockhash can still land", async () => {
    expect(await solanaVerdict(nodeAt(null, 999), aSend())).toBe("wait");
    expect(await solanaVerdict(nodeAt(null, 1_000), aSend())).toBe("wait");
  });

  it("is safe to rebuild a never-seen send once the block height is past the limit", async () => {
    expect(await solanaVerdict(nodeAt(null, 1_001), aSend())).toBe("safe");
    expect(await solanaVerdict(nodeAt(null, 1_001), aSend(), "lost:sig")).toBe("safe");
  });

  it("throws, not guesses, when the node cannot be read", async () => {
    const broken = {
      getSignatureStatus: async () => {
        throw new Error("offline");
      },
      getBlockHeight: async () => 2_000,
    };
    await expect(solanaVerdict(broken, aSend())).rejects.toThrow("offline");
  });
});

describe("seatVerdict", () => {
  const pending: SeatSend = { state: "pending", at: "t", id: "ab12", before: "1000" };

  it("sends when nothing was recorded", () => {
    expect(seatVerdict(undefined, 500n, 1_000n, undefined)).toBe("send");
  });

  it("takes a landed record as landed", () => {
    expect(seatVerdict({ ...pending, state: "landed" }, 500n, 0n, undefined)).toBe("landed");
  });

  it("takes a rollup balance that rose by the amount as landed", () => {
    expect(seatVerdict(pending, 500n, 1_500n, undefined)).toBe("landed");
  });

  it("asks when nothing shows it landed", () => {
    expect(seatVerdict(pending, 500n, 1_499n, undefined)).toBe("ask");
  });

  it("ignores an answer that names another record", () => {
    expect(seatVerdict(pending, 500n, 1_000n, "lost:other")).toBe("ask");
  });

  it("sends again only on a lost answer naming this record", () => {
    expect(seatVerdict(pending, 500n, 1_000n, "lost:ab12")).toBe("send");
  });

  it("lands on a landed answer naming this record", () => {
    expect(seatVerdict(pending, 500n, 1_000n, "landed:ab12")).toBe("landed");
  });
});

describe("exitOperation", () => {
  const asked = { id: "op1", owner: "me", atoms: 500n, method: "shuttle" };
  const sent = (extra: Partial<ExitOperation> = {}): ExitOperation => ({
    id: "old",
    owner: "me",
    atoms: "500",
    method: "shuttle",
    solana: [],
    ...extra,
  });

  it("resumes the unfinished operation for the same amount and method", () => {
    const unfinished = sent({ solana: [aSend()] });
    expect(exitOperation(unfinished, asked)).toBe(unfinished);
  });

  it("refuses a different amount while one is unfinished", () => {
    expect(() => exitOperation(sent({ solana: [aSend()] }), { ...asked, atoms: 900n })).toThrow(
      /earlier exit.*asked for 500 atoms.*Nothing was sent/,
    );
  });

  it("refuses a different method while a seat withdrawal is unfinished", () => {
    const seat: SeatSend = { state: "pending", at: "t", before: "0" };
    expect(() => exitOperation(sent({ seat }), { ...asked, method: "undelegate" })).toThrow(
      /may have landed/,
    );
  });

  it("starts fresh when the recorded one sent nothing", () => {
    expect(exitOperation(sent(), { ...asked, atoms: 900n }).id).toBe("op1");
  });

  it("starts fresh when none was recorded", () => {
    expect(exitOperation(null, asked).solana).toEqual([]);
  });
});

describe("tokenAtoms", () => {
  it("converts decimals exactly", () => {
    expect(tokenAtoms("5", 6)).toBe(5_000_000n);
    expect(tokenAtoms("0.01", 6)).toBe(10_000n);
    expect(tokenAtoms("0.000001", 6)).toBe(1n);
    expect(tokenAtoms("12.5", 6)).toBe(12_500_000n);
  });

  it("refuses more decimals than the mint has", () => {
    expect(() => tokenAtoms("1.0000001", 6)).toThrow("more decimal places than the token has (6)");
    expect(() => tokenAtoms("0.0000001", 6)).toThrow("more decimal places");
  });

  it("refuses what is not a plain positive number", () => {
    for (const bad of ["0", "0.000000", "", "-1", "1e3", " 1", "1 ", "1,5", "abc", ".5"]) {
      expect(() => tokenAtoms(bad, 6), JSON.stringify(bad)).toThrow(/Nothing was sent/);
    }
  });

  it("refuses more than a balance can hold", () => {
    expect(() => tokenAtoms("18446744073709551616", 0)).toThrow("a balance can hold");
    expect(tokenAtoms("18446744073709551615", 0)).toBe(18_446_744_073_709_551_615n);
  });
});
