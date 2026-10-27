"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/format";
import { isAvailableUnknown, transferableAmount } from "@/lib/trading/balanceDisplay";
import type { Balance, KeyWithdrawal, WalletIdentity } from "@/lib/trading/types";
import { atomsText, balanceAtoms, checkAmount, type AmountCheck } from "@/lib/transfer/amount";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import { depositKeyLeftover, readDepositKeyLeftover } from "@/lib/transfer/leftover";
import {
  DepositKeyDeclined,
  deriveDepositKey,
  loadOrCreateDepositKey,
  storedDepositKeys,
  storedDerivedDepositKey,
  storedKeyMatching,
  storedOrUnsavedDepositKey,
  type DepositKey,
  type SignMessage,
} from "@/lib/transfer/depositKeyStore";
import { attentionOf, type Attention } from "@/lib/transfer/attention";
import type { OwnerSigner } from "@/lib/wallet/ownerSigner";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { createJournal, indexedDbStorage } from "@/lib/transfer/journal";
import { checkDepositStorage } from "@/lib/transfer/storageGuard";
import { createMainnetTransferEnv, mainnetTransferPins } from "@/lib/transfer/mainnetEnv";
import {
  ROUND_TRIP_LAMPORTS,
  SOLANA_EXIT_LAMPORTS,
  rollupSendState,
  type TransferEnv,
} from "@/lib/transfer/operation";
import {
  KEY_BALANCE_UNREADABLE,
  KEY_FELL_BACK,
  KEY_SIGNATURE_NOTE,
  NO_UNFINISHED_DEPOSIT,
  TRANSFER_STILL_OPEN,
  failureLine,
  outcomeLine,
  solText,
  type OutcomeLine,
} from "@/lib/transfer/outcomeCopy";
import { PHASE_LINES, withProgress, type Phase } from "@/lib/transfer/progress";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { giveBack, resumeRecord } from "@/lib/transfer/resume";
import { readTokenBalance } from "@/lib/transfer/solanaRpc";
import { associatedTokenAddress } from "@/lib/transfer/tokenAccounts";
import { withdraw } from "@/lib/transfer/withdraw";
import { QUOTE_DECIMALS } from "@/lib/rollup/markets";
import { btnGhost, btnPrimary, input, sectionLabel } from "@/components/ui/styles";
import { TransferRecords, type RecordsEngine } from "@/components/TransferRecords";

type Kind = "deposit" | "withdraw";

const SOL_DECIMALS = 9;

interface EnvOptions {
  /** The env of a new deposit, whose key may have to be made and so may ask the wallet to sign. */
  newDeposit?: boolean;
  /** A key chosen by the caller; it wins over every other choice. */
  given?: DepositKey;
  onPhase?: (phase: Phase) => void;
  /** Called when the wallet could not give a derived key and a random one was made. */
  onFellBack?: () => void;
}

/** `signer`'s message signing, reported as the "sign-key" phase only while the wallet is actually asked. */
const signingWithPhase =
  (signer: Pick<OwnerSigner, "signMessage">, onPhase?: (phase: Phase) => void): SignMessage =>
  async (message) => {
    onPhase?.("sign-key");
    try {
      return await signer.signMessage(message);
    } finally {
      onPhase?.("preparing");
    }
  };

/**
 * The deposit key an env is built with. A new deposit uses the stored key or
 * makes one. Other work uses the stored key that an open record names, else
 * the stored one, else an unsaved one, and never asks the wallet.
 */
async function keyFor(
  address: string,
  signer: Pick<OwnerSigner, "signMessage">,
  options: EnvOptions,
): Promise<DepositKey> {
  if (options.newDeposit) {
    const key = await loadOrCreateDepositKey(
      address,
      typeof signer.signMessage === "function"
        ? signingWithPhase(signer, options.onPhase)
        : undefined,
    );
    if (key.fellBack) options.onFellBack?.();
    return key;
  }
  const records = await createJournal(indexedDbStorage())
    .unfinished(address)
    .catch(() => []);
  const wanted = records.find((record) => record.depositKey !== undefined)?.depositKey;
  return (await storedKeyMatching(address, wanted)) ?? (await storedOrUnsavedDepositKey(address));
}

interface WalletFunds {
  /** Null while unknown: a read that failed is never shown as zero. */
  usdc: bigint | null;
  lamports: bigint | null;
}

const AMOUNT_MESSAGES: Record<
  Exclude<AmountCheck, { ok: true }>["reason"],
  (kind: Kind) => string
> = {
  empty: () => "",
  invalid: () => "Enter a number such as 5 or 0.25.",
  "too-many-decimals": () => "USDC has six decimal places at most.",
  zero: () => "Enter an amount above zero.",
  "above-limit": (kind) =>
    kind === "deposit"
      ? "That is more than the USDC in your wallet."
      : "That is more than your free collateral.",
  "limit-unknown": (kind) =>
    kind === "deposit"
      ? "Your wallet's USDC could not be read, or it holds none yet."
      : "Free collateral is not known yet.",
};

/**
 * Everything that moves USDC between the wallet and the account, and the
 * records of transfers that did not finish. Loaded only by a build with
 * deposits on. The owner signs through the same network-checked signer the
 * trading path uses, and every env is made fresh for the action it serves.
 */
export default function FundsSection({
  identity,
  rollupReader,
  withdrawByKey,
  ownerAuthKnown,
  accountOpen,
  collateral,
  onSettled,
}: {
  identity: WalletIdentity | null;
  rollupReader: (() => Promise<Connection>) | null;
  /** Given only where the deployment takes the owner's consent as a signed message; the seat's withdrawal then needs no wallet signature. */
  withdrawByKey: ((atoms: bigint) => Promise<KeyWithdrawal>) | null;
  /** False until that is known, so a withdrawal cannot start on the wrong path. */
  ownerAuthKnown: boolean;
  accountOpen: boolean;
  collateral: Balance | null;
  /** Called when a transfer finished, so the account is read again. */
  onSettled: () => void;
}) {
  const signer = identity?.signer;
  const owner = identity?.address ?? null;
  const solana = useMemo(() => new Connection(env.solanaRpcUrl ?? "", "confirmed"), []);
  const accountOpenRef = useRef(accountOpen);
  useEffect(() => {
    accountOpenRef.current = accountOpen;
  }, [accountOpen]);

  const ownerRef = useRef(owner);
  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);

  const makeEnv = useCallback(
    async (options: EnvOptions = {}): Promise<TransferEnv> => {
      if (!signer || !rollupReader) throw new Error("Connect a wallet first.");
      if (!ownerAuthKnown)
        throw new Error("Still loading the account settings. Try again in a moment.");
      const rollup = await rollupReader();
      const address = signer.publicKey.toBase58();
      const key = options.given ?? (await keyFor(address, signer, options));
      return createMainnetTransferEnv({
        signer,
        solana,
        rollup,
        rollupEndpoint: rollup.rpcEndpoint,
        depositKey: key.keypair,
        depositKeyDerived: key.derived,
        accountOpen: async () => accountOpenRef.current,
        ...(withdrawByKey ? { withdrawByKey } : {}),
      });
    },
    [signer, rollupReader, solana, withdrawByKey, ownerAuthKnown],
  );

  const freeCollateral =
    collateral && !isAvailableUnknown(collateral)
      ? balanceAtoms(transferableAmount(collateral), QUOTE_DECIMALS)
      : null;

  const latest = useRef({ freeCollateral, onSettled });
  useEffect(() => {
    latest.current = { freeCollateral, onSettled };
  }, [freeCollateral, onSettled]);

  const runResume = useCallback(
    async (
      attention: Attention,
      onStep: (phase: Phase) => void,
    ): Promise<{ line: OutcomeLine; done: boolean }> => {
      const transfer = withProgress(await makeEnv(), onStep);
      const outcome = await resumeRecord(
        transfer,
        attention,
        latest.current.freeCollateral ?? 0n,
        { deposit, withdraw, returnToWallet },
        QUOTE_DECIMALS,
      );
      if (outcome.status === "done") latest.current.onSettled();
      const resumed = attention.operation === "deposit" ? "deposit" : "withdraw";
      return {
        done: outcome.status === "done",
        line: outcomeLine(
          resumed,
          outcome,
          QUOTE_DECIMALS,
          resumed === "deposit" ? ROUND_TRIP_LAMPORTS : SOLANA_EXIT_LAMPORTS,
        ),
      };
    },
    [makeEnv],
  );

  /** The stored key, random or derived, that holds a balance in the rollup; the wallet is never asked. */
  const findLeftover = useCallback(async (): Promise<{
    key: DepositKey;
    atoms: bigint;
  } | null> => {
    if (!signer) return null;
    for (const key of await storedDepositKeys(signer.publicKey.toBase58())) {
      const atoms = await depositKeyLeftover(await makeEnv({ given: key }));
      if (atoms !== null) return { key, atoms };
    }
    return null;
  }, [signer, makeEnv]);

  const engine = useMemo<RecordsEngine | null>(
    () =>
      signer && rollupReader
        ? {
            judge: async (records) => {
              const transfer = await makeEnv();
              const judged: Record<string, Awaited<ReturnType<typeof rollupSendState>>["kind"]> =
                {};
              for (const record of records) {
                if (record.seat?.state === "pending") {
                  judged[record.id] = (await rollupSendState(transfer, record.seat)).kind;
                }
              }
              return judged;
            },
            dismiss: async () => dismissRollupSend(await makeEnv()),
            resume: async (attention, report) =>
              (await runResume(attention, (step) => report(PHASE_LINES[step]))).line.text,
            leftover: async () => (await findLeftover())?.atoms ?? null,
            recover: async (report) => {
              const given = (await findLeftover())?.key;
              const transfer = withProgress(await makeEnv({ given }), (step) =>
                report(PHASE_LINES[step]),
              );
              const outcome = await recoverDepositKey(transfer);
              if (outcome.status === "done") latest.current.onSettled();
              return outcomeLine("deposit", outcome, QUOTE_DECIMALS, ROUND_TRIP_LAMPORTS).text;
            },
            giveBack: async (attention, report) => {
              const transfer = withProgress(await makeEnv(), (step) => report(PHASE_LINES[step]));
              const outcome = await giveBack(transfer, attention, { returnToWallet });
              if (outcome.status === "done") latest.current.onSettled();
              return outcomeLine("withdraw", outcome, QUOTE_DECIMALS, SOLANA_EXIT_LAMPORTS).text;
            },
          }
        : null,
    [signer, rollupReader, makeEnv, runResume, findLeftover],
  );
  const [blocked, setBlocked] = useState(true);

  const [refreshKey, setRefreshKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("deposit");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [result, setResult] = useState<OutcomeLine | null>(null);
  const [storageCaution, setStorageCaution] = useState(false);
  const [funds, setFunds] = useState<WalletFunds>({ usdc: null, lamports: null });

  const readFunds = useCallback(async (): Promise<WalletFunds | null> => {
    if (!owner) return null;
    const key = new PublicKey(owner);
    const [lamports, usdc] = await Promise.all([
      solana.getBalance(key, "confirmed").then(
        (value) => BigInt(value),
        () => null,
      ),
      readTokenBalance(solana, associatedTokenAddress(key, mainnetTransferPins().mint)).catch(
        () => null,
      ),
    ]);
    return { usdc, lamports };
  }, [owner, solana]);

  const [derivedStored, setDerivedStored] = useState<boolean | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [seenOwner, setSeenOwner] = useState(owner);
  if (seenOwner !== owner) {
    setSeenOwner(owner);
    setResult(null);
    setPhase(null);
    setDerivedStored(null);
    setOpen(false);
    setFellBack(false);
    setStorageCaution(false);
  }

  useEffect(() => {
    if (!owner) return;
    let active = true;
    void storedDerivedDepositKey(owner).then(
      (stored) => {
        if (active) setDerivedStored(stored !== null);
      },
      () => {
        if (active) setDerivedStored(null);
      },
    );
    return () => {
      active = false;
    };
  }, [owner, refreshKey]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void readFunds().then((read) => {
      if (active && read) setFunds(read);
    });
    return () => {
      active = false;
    };
  }, [open, readFunds, refreshKey]);

  if (!owner || !signer) return null;

  const limit = kind === "deposit" ? funds.usdc : freeCollateral;
  const check = checkAmount(text, QUOTE_DECIMALS, limit);
  const busy = phase !== null;
  const feeLamports = kind === "deposit" ? ROUND_TRIP_LAMPORTS : SOLANA_EXIT_LAMPORTS;
  const lacksSol = funds.lamports !== null && funds.lamports < BigInt(feeLamports);

  const started = owner;
  const sameOwner = () => ownerRef.current === started;
  const say = (line: OutcomeLine | null) => {
    if (sameOwner()) setResult(line);
  };

  const storageAllows = async (): Promise<boolean> => {
    const stored = await checkDepositStorage({
      storage: typeof navigator === "undefined" ? undefined : navigator.storage,
      openRecords: () => createJournal(indexedDbStorage()).unfinished(started),
    });
    if (sameOwner()) setStorageCaution(stored.ok && !stored.persisted);
    if (!stored.ok) say({ tone: "error", text: stored.reason });
    return stored.ok;
  };

  const failureOf = (error: unknown): OutcomeLine =>
    error instanceof DepositKeyDeclined
      ? { tone: "error", text: error.message }
      : failureLine(error);

  async function submit() {
    if (!check.ok) return;
    say(null);
    setPhase("preparing");
    try {
      if (kind === "deposit" && !(await storageAllows())) return;
      const transfer = withProgress(
        await makeEnv({
          newDeposit: kind === "deposit",
          onPhase: setPhase,
          onFellBack: () => setFellBack(true),
        }),
        setPhase,
      );
      const amount = atomsText(check.atoms, QUOTE_DECIMALS);
      const outcome =
        kind === "deposit"
          ? await deposit(transfer, { amount, intent: { kind: "new" } })
          : await withdraw(transfer, {
              amount,
              freeCollateral: freeCollateral ?? 0n,
              intent: { kind: "new" },
            });
      say(outcomeLine(kind, outcome, QUOTE_DECIMALS, feeLamports));
      if (outcome.status === "done") {
        if (sameOwner()) setText("");
        onSettled();
      }
    } catch (error) {
      say(failureOf(error));
    } finally {
      if (sameOwner()) setPhase(null);
      setRefreshKey((count) => count + 1);
    }
  }

  const canFinishElsewhere = !busy && ownerAuthKnown && rollupReader !== null && accountOpen;

  const finishFromAnotherBrowser = async () => {
    if (!canFinishElsewhere) return;
    setOpen(true);
    say(null);
    setPhase("preparing");
    try {
      if (!(await storageAllows())) return;
      const records = await createJournal(indexedDbStorage()).unfinished(started);
      if (records.length > 0) {
        const held = await storedDepositKeys(started);
        const heldHere = records.some((record) =>
          held.some((key) => key.keypair.publicKey.toBase58() === record.depositKey),
        );
        const storedDerived = held.find((key) => key.derived);
        const derived =
          storedDerived ??
          (heldHere
            ? undefined
            : await deriveDepositKey(started, signingWithPhase(signer, setPhase)));
        const mine = records.find(
          (record) => record.depositKey === derived?.keypair.publicKey.toBase58(),
        );
        if (!mine) {
          say({ tone: "warn", text: TRANSFER_STILL_OPEN });
          return;
        }
        const resumed = await runResume(attentionOf(mine, null, records), setPhase);
        say(resumed.line);
        return;
      }
      const key = await deriveDepositKey(started, signingWithPhase(signer, setPhase));
      const transfer = withProgress(await makeEnv({ given: key }), setPhase);
      let held: bigint;
      try {
        held = await readDepositKeyLeftover(transfer);
      } catch {
        say({ tone: "error", text: KEY_BALANCE_UNREADABLE });
        return;
      }
      if (held === 0n) {
        say({ tone: "warn", text: NO_UNFINISHED_DEPOSIT });
        return;
      }
      const outcome = await recoverDepositKey(transfer);
      say(outcomeLine("deposit", outcome, QUOTE_DECIMALS, ROUND_TRIP_LAMPORTS));
      if (outcome.status === "done") onSettled();
    } catch (error) {
      say(failureOf(error));
    } finally {
      if (sameOwner()) setPhase(null);
      setRefreshKey((count) => count + 1);
    }
  };

  return (
    <div>
      <TransferRecords
        owner={owner}
        engine={engine}
        refreshKey={refreshKey}
        onBlocked={setBlocked}
      />
      <div className="border-line-subtle border-b p-3">
        {!open ? (
          <button
            type="button"
            className={`${btnGhost} w-full px-3 text-[12px]`}
            onClick={() => setOpen(true)}
          >
            Add or withdraw USDC
          </button>
        ) : (
          <div>
            <p className={sectionLabel}>Move USDC</p>
            <div className="mt-2 flex gap-2" role="group" aria-label="Direction">
              {(["deposit", "withdraw"] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={kind === choice}
                  disabled={busy}
                  onClick={() => {
                    setKind(choice);
                    setResult(null);
                  }}
                  className={`rounded-tile min-h-11 flex-1 border px-2 text-[12px] ${kind === choice ? "border-line-strong bg-elevated text-ink" : "border-line text-dim"}`}
                >
                  {choice === "deposit" ? "Deposit" : "Withdraw"}
                </button>
              ))}
            </div>
            <p className="text-faint tnum mt-2 text-[11px]">
              Wallet{" "}
              {funds.usdc === null
                ? "USDC unavailable"
                : formatMoney(atomsText(funds.usdc, QUOTE_DECIMALS), "USDC")}
              {" · "}
              {funds.lamports === null
                ? "SOL unavailable"
                : `${atomsText(funds.lamports, SOL_DECIMALS).replace(/0+$/, "").replace(/\.$/, "")} SOL`}
              {kind === "withdraw" && (
                <>
                  {" · "}Free collateral{" "}
                  {freeCollateral === null
                    ? "unavailable"
                    : formatMoney(atomsText(freeCollateral, QUOTE_DECIMALS), "USDC")}
                </>
              )}
            </p>
            {blocked && (
              <p role="status" className="text-dim mt-1 text-[12px]">
                A transfer is open or its record is still loading. Finish it or wait for it first; a
                new one cannot start until then.
              </p>
            )}
            {!accountOpen && (
              <p className="text-dim mt-1 text-[12px]">Open your account before moving USDC.</p>
            )}
            {lacksSol && (
              <p role="alert" className="text-danger mt-1 text-[12px]">
                The network fees for this need about {solText(feeLamports)} in your wallet, and it
                holds less. Add SOL first.
              </p>
            )}
            <input
              className={`${input} mt-2`}
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              aria-label={`${kind === "deposit" ? "Deposit" : "Withdraw"} amount (USDC)`}
            />
            {!check.ok && AMOUNT_MESSAGES[check.reason](kind) !== "" && (
              <p className="text-dim mt-1 text-[12px]">{AMOUNT_MESSAGES[check.reason](kind)}</p>
            )}
            {check.ok ? (
              <div className="bg-surface-raised rounded-tile border-line-subtle mt-2 border p-2.5">
                <p className="text-ink text-[13px]">
                  You are moving{" "}
                  <span className="tnum font-medium">{atomsText(check.atoms, QUOTE_DECIMALS)}</span>{" "}
                  USDC{" "}
                  {kind === "deposit"
                    ? "from your wallet to your trading account."
                    : "from your trading account to your wallet."}
                </p>
                <p className="text-faint mt-1 text-[11px]">
                  {kind === "deposit"
                    ? `${derivedStored === false ? KEY_SIGNATURE_NOTE : ""}Your wallet will ask you to approve one transaction, and you pay about ${solText(feeLamports)} in network fees. It usually takes a minute or two; keep this page open.`
                    : `Your wallet will ask you to approve ${withdrawByKey ? "one or two" : "two or three"} transactions, and you pay about ${solText(feeLamports)} in network fees. A withdrawal can wait a few minutes for fresh prices; keep this page open.`}
                </p>
              </div>
            ) : (
              <p className="text-faint mt-1 text-[11px]">
                {kind === "deposit"
                  ? `${derivedStored === false ? KEY_SIGNATURE_NOTE : ""}Your wallet asks you to approve one transaction.`
                  : `Your wallet asks you to approve ${withdrawByKey ? "one or two" : "two or three"} transactions. A withdrawal can wait a few minutes for fresh prices.`}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`${btnGhost} flex-1 text-[12px]`}
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setResult(null);
                }}
              >
                Close
              </button>
              <button
                type="button"
                className={`${btnPrimary} flex-1 text-[12px]`}
                disabled={
                  busy ||
                  blocked ||
                  !check.ok ||
                  !accountOpen ||
                  (kind === "withdraw" && !ownerAuthKnown)
                }
                onClick={() => void submit()}
              >
                {kind === "deposit" ? "Deposit" : "Withdraw"}
                {check.ok ? ` ${atomsText(check.atoms, QUOTE_DECIMALS)} USDC` : ""}
              </button>
            </div>
            {phase && (
              <p role="status" className="text-dim mt-2 text-[12px]">
                {PHASE_LINES[phase]}
              </p>
            )}
            {fellBack && (
              <p role="status" className="text-warning mt-2 text-[12px]">
                {KEY_FELL_BACK}
              </p>
            )}
            {storageCaution && kind === "deposit" && (
              <p role="status" className="text-warning mt-2 text-[12px]">
                Your browser has not promised to keep this app&apos;s data. Until the deposit shows
                Done, do not clear site data, close private windows or switch browsers.
              </p>
            )}
            {result && (
              <p
                role={result.tone === "error" ? "alert" : "status"}
                className={`mt-2 text-[12px] ${result.tone === "error" ? "text-danger" : result.tone === "ok" ? "text-safe" : "text-dim"}`}
              >
                {result.text}
              </p>
            )}
          </div>
        )}
        {!open && (
          <div className="mt-2">
            <button
              type="button"
              className="text-faint w-full text-center text-[11px] underline"
              disabled={!canFinishElsewhere}
              onClick={() => void finishFromAnotherBrowser()}
            >
              Finish a deposit from another browser
            </button>
            <p className="text-faint mt-1 text-center text-[11px]">
              {derivedStored === false && "Your wallet is asked to sign a message first. "}Use this
              only after the other browser has stopped. Running both at once can leave a record
              there that reads wrong.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
