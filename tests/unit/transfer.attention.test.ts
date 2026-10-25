import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionsOf,
  attentionOf,
  shortSignature,
  type AttentionKind,
  type SeatJudgement,
} from "@/lib/transfer/attention";
import type { OperationRecord } from "@/lib/transfer/journal";
import { PHASE_LINES } from "@/lib/transfer/progress";

const SIGNATURE = "5".repeat(88);

const record = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "op1",
  kind: "withdraw",
  atoms: "5000000",
  step: "withdraw",
  sends: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const pendingSeat = {
  state: "pending" as const,
  at: "2026-10-25T10:00:00.000Z",
  id: "seat1",
  before: "0",
  signature: SIGNATURE,
  lastValidBlockHeight: 500,
};

const kindOf = (seat: SeatJudgement | null, rec = record({ seat: pendingSeat })): AttentionKind =>
  attentionOf(rec, seat).kind;

describe("which records offer Dismiss", () => {
  it("only a rollup send read as absent past its blockhash is not-landed, and only that offers Dismiss", () => {
    const judgements: Array<SeatJudgement | null> = [
      "landed",
      "failed",
      "pending",
      "not-seen",
      "unknown",
      null,
    ];
    const dismissable = judgements.filter((seat) =>
      actionsOf(attentionOf(record({ seat: pendingSeat }), seat)).includes("dismiss"),
    );
    expect(dismissable).toEqual(["not-seen"]);
  });

  it("shows a send whose status cannot be read as unknown, with no Dismiss", () => {
    const attention = attentionOf(record({ seat: pendingSeat }), "unknown");
    expect(attention.kind).toBe("unknown");
    expect(attention.signature).toBe(SIGNATURE);
    expect(actionsOf(attention)).toEqual(["copy-signature"]);
  });

  it("shows a send that may still land as waiting, with the signature to copy and no Dismiss", () => {
    const attention = attentionOf(record({ seat: pendingSeat }), "pending");
    expect(attention.kind).toBe("waiting");
    expect(actionsOf(attention)).toEqual(["copy-signature"]);
  });

  it("never judges a record with no pending rollup send as not-landed or unknown", () => {
    const solanaOnly = record({
      sends: [
        {
          signature: "sig",
          lastValidBlockHeight: 10,
          at: 1,
          before: "0",
          moved: "5000000",
        },
      ],
    });
    for (const seat of ["not-seen", "unknown"] as const) {
      expect(kindOf(seat, solanaOnly)).toBe("waiting");
      expect(actionsOf(attentionOf(solanaOnly, seat))).not.toContain("dismiss");
    }
  });

  it("does not judge a landed seat send even when told it is absent", () => {
    const landed = record({ seat: { ...pendingSeat, state: "landed" } });
    expect(kindOf("not-seen", landed)).toBe("waiting");
  });

  it("offers only Resume for a record with no signature yet", () => {
    expect(actionsOf(attentionOf(record(), null))).toEqual(["resume"]);
  });

  it("names a return to the wallet as such", () => {
    expect(attentionOf(record({ step: "return" }), null).operation).toBe("return");
    expect(attentionOf(record({ kind: "deposit", step: "deposit" }), null).operation).toBe(
      "deposit",
    );
  });
});

describe("no path offers a resend", () => {
  const everyKind: AttentionKind[] = ["waiting", "not-landed", "unknown"];

  it("lets a record offer copy and dismiss and nothing else", () => {
    for (const kind of everyKind) {
      const actions = actionsOf({
        id: "x",
        kind,
        operation: "deposit",
        atoms: "1",
        signature: "s",
        resumable: true,
      });
      for (const action of actions) {
        expect(["copy-signature", "dismiss", "resume"]).toContain(action);
      }
    }
  });

  const read = (...parts: string[]) =>
    readFileSync(path.join(import.meta.dirname, "../../src", ...parts), "utf8");

  it("keeps every UI file away from the calls that send a transaction", () => {
    const forbidden =
      /sendRawTransaction|sendJournaled|sentOnRollup|signedAndRecordedOnRollup|recordThenBroadcast|returnToWallet|shuttleToWallet/;
    for (const file of ["TransferRecords.tsx", "FundsSection.tsx"]) {
      expect(read("components", file)).not.toMatch(forbidden);
    }
    expect(read("lib", "transfer", "attention.ts")).not.toMatch(forbidden);
  });

  it("reaches the transfer flows only through deposit, withdraw and dismiss", () => {
    const flows = read("components", "FundsSection.tsx");
    const used = [...flows.matchAll(/from "@\/lib\/transfer\/(\w+)"/g)].map((found) => found[1]);
    for (const name of used) {
      expect([
        "amount",
        "deposit",
        "dismiss",
        "mainnetEnv",
        "operation",
        "outcomeCopy",
        "progress",
        "resume",
        "solanaRpc",
        "tokenAccounts",
        "withdraw",
      ]).toContain(name);
    }
  });
});

describe("a build with deposits off reaches no transfer flow from the UI", () => {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [path.join(directory, entry.name)]
          : [],
    );
  const root = path.join(import.meta.dirname, "../../src");
  const flowImport =
    /from "(?:@\/lib|\.\.?(?:\/\.\.)*\/lib|\.\.?)\/(?:transfer\/(?:deposit|withdraw|dismiss|returnToWallet|mainnetEnv|operation|progress|outcomeCopy)|rollup\/ownerSend)"/;

  it("imports the flows statically from FundsSection and nowhere in the UI", () => {
    const importers = sourceFiles(path.join(root, "components")).filter((file) =>
      flowImport.test(readFileSync(file, "utf8").replace(/import type[\s\S]*?;/g, "")),
    );
    expect(importers.map((file) => path.basename(file))).toEqual(["FundsSection.tsx"]);
  });

  it("loads FundsSection only behind the build-time switch", () => {
    const terminal = readFileSync(path.join(root, "components/Terminal.tsx"), "utf8");
    expect(terminal).not.toMatch(/import \{[^}]*\} from "@\/components\/FundsSection"/);
    expect(terminal).toMatch(
      /process\.env\.NEXT_PUBLIC_DEPOSITS === "on"\s*\?\s*lazy\(\(\) => import\("@\/components\/FundsSection"\)\)\s*:\s*null/,
    );
  });

  it("still shows the record of an unfinished transfer, with no engine", () => {
    const terminal = readFileSync(path.join(root, "components/Terminal.tsx"), "utf8");
    expect(terminal).toMatch(/<TransferRecords owner=\{[^}]*\} engine=\{null\} \/>/);
  });
});

describe("progress lines", () => {
  it("has one line for each phase of a step", () => {
    expect(Object.keys(PHASE_LINES)).toEqual(["preparing", "approve", "sending", "finality"]);
  });
});

describe("shortSignature", () => {
  it("keeps the ends of a long signature and a short one whole", () => {
    expect(shortSignature(SIGNATURE)).toBe("55555555...55555555");
    expect(shortSignature("abc")).toBe("abc");
  });
});
