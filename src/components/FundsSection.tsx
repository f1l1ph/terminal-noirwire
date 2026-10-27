"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/format";
import { isAvailableUnknown, transferableAmount } from "@/lib/trading/balanceDisplay";
import type { Balance, KeyWithdrawal, WalletIdentity } from "@/lib/trading/types";
import { atomsText, balanceAtoms, checkAmount, type AmountCheck } from "@/lib/transfer/amount";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import { depositKeyLeftover } from "@/lib/transfer/leftover";
import { loadOrCreateDepositKey } from "@/lib/transfer/depositKeyStore";
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
import { failureLine, outcomeLine, solText, type OutcomeLine } from "@/lib/transfer/outcomeCopy";
import { PHASE_LINES, withProgress, type Phase } from "@/lib/transfer/progress";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { giveBack, resumeRecord } from "@/lib/transfer/resume";
import { readTokenBalance } from "@/lib/transfer/solanaRpc";
import { associatedTokenAddress } from "@/lib/transfer/tokenAccounts";
import { withdraw } from "@/lib/transfer/withdraw";
import { QUOTE_DECIMALS } from "@/lib/rollup/markets";
import { needsAcknowledgement, recordAcknowledgement } from "@/lib/trading/realMoneyAck";
import { browserLocalStorage } from "@/lib/wallet";
import { RealMoneyDialog } from "@/components/OrderDialogs";
import { btnGhost, btnPrimary, input, sectionLabel } from "@/components/ui/styles";
import { TransferRecords, type RecordsEngine } from "@/components/TransferRecords";

type Kind = "deposit" | "withdraw";

const SOL_DECIMALS = 9;

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

  const makeEnv = useCallback(async (): Promise<TransferEnv> => {
    if (!signer || !rollupReader) throw new Error("Connect a wallet first.");
    if (!ownerAuthKnown)
      throw new Error("Still loading the account settings. Try again in a moment.");
    const rollup = await rollupReader();
    return createMainnetTransferEnv({
      signer,
      solana,
      rollup,
      rollupEndpoint: rollup.rpcEndpoint,
      depositKey: await loadOrCreateDepositKey(signer.publicKey.toBase58()),
      accountOpen: async () => accountOpenRef.current,
      ...(withdrawByKey ? { withdrawByKey } : {}),
    });
  }, [signer, rollupReader, solana, withdrawByKey, ownerAuthKnown]);

  const freeCollateral =
    collateral && !isAvailableUnknown(collateral)
      ? balanceAtoms(transferableAmount(collateral), QUOTE_DECIMALS)
      : null;

  const latest = useRef({ freeCollateral, onSettled });
  useEffect(() => {
    latest.current = { freeCollateral, onSettled };
  }, [freeCollateral, onSettled]);

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
            resume: async (attention, report) => {
              const transfer = withProgress(await makeEnv(), (step) => report(PHASE_LINES[step]));
              const outcome = await resumeRecord(
                transfer,
                attention,
                latest.current.freeCollateral ?? 0n,
                { deposit, withdraw, returnToWallet },
                QUOTE_DECIMALS,
              );
              if (outcome.status === "done") latest.current.onSettled();
              const resumed = attention.operation === "deposit" ? "deposit" : "withdraw";
              return outcomeLine(
                resumed,
                outcome,
                QUOTE_DECIMALS,
                resumed === "deposit" ? ROUND_TRIP_LAMPORTS : SOLANA_EXIT_LAMPORTS,
              ).text;
            },
            leftover: async () => depositKeyLeftover(await makeEnv()),
            recover: async (report) => {
              const transfer = withProgress(await makeEnv(), (step) => report(PHASE_LINES[step]));
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
    [signer, rollupReader, makeEnv],
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
  const [ackedBy, setAckedBy] = useState<string | null>(null);
  const [showAck, setShowAck] = useState(false);

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

  async function submit() {
    if (!check.ok) return;
    setResult(null);
    setPhase("preparing");
    try {
      if (kind === "deposit") {
        const stored = await checkDepositStorage({
          storage: typeof navigator === "undefined" ? undefined : navigator.storage,
          openRecords: () => createJournal(indexedDbStorage()).unfinished(owner as string),
        });
        setStorageCaution(stored.ok && !stored.persisted);
        if (!stored.ok) {
          setResult({ tone: "error", text: stored.reason });
          return;
        }
      }
      const transfer = withProgress(await makeEnv(), setPhase);
      const amount = atomsText(check.atoms, QUOTE_DECIMALS);
      const outcome =
        kind === "deposit"
          ? await deposit(transfer, { amount, intent: { kind: "new" } })
          : await withdraw(transfer, {
              amount,
              freeCollateral: freeCollateral ?? 0n,
              intent: { kind: "new" },
            });
      setResult(outcomeLine(kind, outcome, QUOTE_DECIMALS, feeLamports));
      if (outcome.status === "done") {
        setText("");
        onSettled();
      }
    } catch (error) {
      setResult(failureLine(error));
    } finally {
      setPhase(null);
      setRefreshKey((count) => count + 1);
    }
  }

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
                    ? `Your wallet will ask you to approve one transaction, and you pay about ${solText(feeLamports)} in network fees. It usually takes a minute or two; keep this page open.`
                    : `Your wallet will ask you to approve ${withdrawByKey ? "one or two" : "two or three"} transactions, and you pay about ${solText(feeLamports)} in network fees. A withdrawal can wait a few minutes for fresh prices; keep this page open.`}
                </p>
              </div>
            ) : (
              <p className="text-faint mt-1 text-[11px]">
                {kind === "deposit"
                  ? "Your wallet asks you to approve one transaction."
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
                onClick={() => {
                  if (
                    kind === "deposit" &&
                    needsAcknowledgement(browserLocalStorage(), owner, ackedBy)
                  ) {
                    setShowAck(true);
                    return;
                  }
                  void submit();
                }}
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
      </div>
      {showAck && (
        <RealMoneyDialog
          onBack={() => setShowAck(false)}
          onAccept={() => {
            recordAcknowledgement(browserLocalStorage(), owner);
            setAckedBy(owner);
            setShowAck(false);
            void submit();
          }}
        />
      )}
    </div>
  );
}
