import { describe, expect, it } from "vitest";
import { checkDepositStorage, type BrowserStorageEnv } from "@/lib/transfer/storageGuard";
import { attentionOf, depositInProgress } from "@/lib/transfer/attention";
import type { OperationRecord } from "@/lib/transfer/journal";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";

const ROOMY = 2 * 1024 * 1024 * 1024;

function browser(overrides: Partial<BrowserStorageEnv> = {}): BrowserStorageEnv {
  return {
    storage: {
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ quota: ROOMY }),
    },
    openRecords: async () => [],
    ...overrides,
  };
}

describe("checkDepositStorage", () => {
  it("lets a deposit start in a browser that keeps its data", async () => {
    expect(await checkDepositStorage(browser())).toEqual({ ok: true, persisted: true });
  });

  it("asks the browser to keep the data before anything is signed, and reads the answer", async () => {
    const calls: string[] = [];
    const result = await checkDepositStorage(
      browser({
        storage: {
          estimate: async () => ({ quota: ROOMY }),
          persist: async () => {
            calls.push("persist");
            return true;
          },
          persisted: async () => {
            calls.push("persisted");
            return true;
          },
        },
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(["persist", "persisted"]);
  });

  it("still lets it start, and says so, when the browser will not promise to keep the data", async () => {
    const result = await checkDepositStorage(
      browser({
        storage: {
          estimate: async () => ({ quota: ROOMY }),
          persist: async () => false,
          persisted: async () => false,
        },
      }),
    );
    expect(result).toEqual({ ok: true, persisted: false });
  });

  it("refuses when the browser offers no storage", async () => {
    const result = await checkDepositStorage(browser({ storage: undefined }));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(/not letting the app save data/);
    expect(result.ok === false && result.reason).toMatch(/Nothing was sent/);
  });

  it("refuses when the transfer records cannot be opened", async () => {
    const result = await checkDepositStorage(
      browser({
        openRecords: async () => {
          throw new Error("browser storage is blocked");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).not.toContain("blocked");
  });

  it("refuses in a private window, whose small quota is dropped when it closes", async () => {
    const result = await checkDepositStorage(
      browser({
        storage: {
          estimate: async () => ({ quota: 100 * 1024 * 1024 }),
          persist: async () => false,
          persisted: async () => false,
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/private window/);
  });

  it("does not take a small quota for a private window when the browser promises to keep the data", async () => {
    const result = await checkDepositStorage(
      browser({
        storage: {
          estimate: async () => ({ quota: 100 * 1024 * 1024 }),
          persist: async () => true,
          persisted: async () => true,
        },
      }),
    );
    expect(result).toEqual({ ok: true, persisted: true });
  });

  it("does not refuse for a browser that cannot report its quota or be asked to persist", async () => {
    const result = await checkDepositStorage(browser({ storage: {} }));
    expect(result).toEqual({ ok: true, persisted: false });
  });

  it("does not let a failing persist call stop a deposit that has room", async () => {
    const result = await checkDepositStorage(
      browser({
        storage: {
          estimate: async () => ({ quota: ROOMY }),
          persist: async () => {
            throw new Error("denied");
          },
        },
      }),
    );
    expect(result).toEqual({ ok: true, persisted: false });
  });
});

function record(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    id: "tx-1",
    kind: "deposit",
    atoms: "1000000",
    step: "deposit",
    sends: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("depositInProgress", () => {
  it("is true while a deposit record is open", () => {
    expect(depositInProgress([record({})])).toBe(true);
  });

  it("is false with no record, and for a withdrawal or a return", () => {
    expect(depositInProgress([])).toBe(false);
    expect(depositInProgress([record({ kind: "withdraw", step: "withdraw" })])).toBe(false);
    expect(depositInProgress([record({ id: "tx-1.return", step: "return" })])).toBe(false);
    expect(attentionOf(record({ step: "return" }), null).operation).toBe("return");
  });
});

describe("deposit copy", () => {
  it("names the transfer id and says to contact support when the key is gone, with no raw error", () => {
    const line = outcomeLine(
      "deposit",
      {
        status: "refused",
        reason: "deposit-key-missing",
        message: "The key that finishes this deposit (transfer tx-1) is no longer stored.",
      },
      6,
      35_000_000,
    );
    expect(line.text).toContain("transfer tx-1");
  });

  it("says a stranded deposit is safe and needs no more money", () => {
    const line = outcomeLine(
      "deposit",
      {
        status: "stranded",
        id: "tx-1",
        recordKept: false,
        message:
          "The exchange did not accept the last step. Your USDC left your wallet and is safe.",
      },
      6,
      35_000_000,
    );
    expect(line.text).toContain('"Put it in my account"');
    expect(line.text).not.toContain("Try the deposit again");
    expect(line.text).not.toMatch(/deposit again by hand/);
  });
});
