"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexToBytes, ownerDataKeys } from "../wallet/index";
import { isMainnetBuild } from "../network";
import { redactToken } from "../rollup/redact";
import { loadTrackedSecrets } from "../rollup/secretStore";
import { createTradingClient } from "./index";
import { createLatestReads } from "./latestRead";
import {
  hasExposureIn,
  MARGIN_REFRESH_STALE_RETRY_MS,
  markRepriceDelayMs,
  nextMarginRefreshDelayMs,
} from "./marginRefresh";
import { withoutOpenOutcome } from "./openCopy";
import type {
  AccountStatus,
  CancelResult,
  FundOutcome,
  MarketSettingsLookup,
  NewOrderInput,
  OpenAccountOutcome,
  OrderKeyState,
  PlaceOrderResult,
  TraderState,
  TransferResult,
  WalletIdentity,
} from "./types";

const EMPTY_STATE: TraderState = {
  trader: "",
  equity: "0",
  balances: {},
  positions: {},
  openOrders: [],
};

/** Calls back with the ids of the markets that just got a newer live mark; returns the way to stop. Keep its identity stable. */
export type SubscribeNewerMarks = (onNewer: (marketIds: string[]) => void) => () => void;

export interface PlacedOrderOutcome {
  result: PlaceOrderResult;
  /** Click-to-acknowledgement, measured on this device with a monotonic clock. */
  clientDurationMs: number;
}

interface OwnerFlow {
  status: AccountStatus;
  opening: boolean;
  outcome: OpenAccountOutcome | null;
  keys: OrderKeyState | null;
  makersListed: ReadonlySet<string>;
}

const NO_MARKETS: ReadonlySet<string> = new Set();
const NO_FLOW: OwnerFlow = {
  status: "unknown",
  opening: false,
  outcome: null,
  keys: null,
  makersListed: NO_MARKETS,
};

interface AccountRead {
  state: TraderState | null;
  syncedAtMs: number | null;
  error: string | null;
}

/**
 * Whether this wallet has ever asked for its one-time grant, so a reload
 * never re-offers the test-funds grant to an account that already used it
 * and has since spent it down to zero (third design review, must-fix 2).
 * Local to this browser: a wallet funded elsewhere first still sees the
 * button once, learns `alreadyFunded`, and is remembered here from then on.
 */
const grantUsedKey = ownerDataKeys.grantUsed;

function readGrantUsed(address: string | null): boolean {
  if (!address || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(grantUsedKey(address)) === "1";
  } catch {
    return false;
  }
}

function writeGrantUsed(address: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(grantUsedKey(address), "1");
  } catch {
    // Best effort; worst case the button is offered again next reload.
  }
}

/**
 * One trading session: the selected trading client (dev or rollup), the
 * trader's live state, and this session's own-fill recognition state. Dev
 * mode recognises its own fills by a venue-assigned tag (`ownTags`); rollup
 * mode has no such tag and instead recomputes receipts from this session's
 * own order secrets (`rollupSecrets`, persisted per owner address so a
 * reload still recognises them - see `src/lib/rollup/secretStore.ts`).
 */
export function useTrading(
  wallet: WalletIdentity | null,
  marketSettingsLookup: MarketSettingsLookup,
  subscribeMarks?: SubscribeNewerMarks,
) {
  const client = useMemo(() => createTradingClient(marketSettingsLookup), [marketSettingsLookup]);
  // What was last read for each wallet, keyed by its address: a late
  // callback from a wallet no longer in view can only ever write its own
  // entry, never the current wallet's. `state` stays null until a first
  // successful read, so an account not read yet is never shown as an empty
  // one; `error` is set when it could not be read and cleared by the next
  // state. `syncedAtMs` is the one piece of truth the footer's sync status
  // reads: set every time this hook writes `state` from the venue.
  const [reads, setReads] = useState<Record<string, AccountRead>>({});
  const setStateSynced = useCallback((owner: string, next: TraderState) => {
    setReads((prev) => ({
      ...prev,
      [owner]: { state: next, syncedAtMs: Date.now(), error: null },
    }));
  }, []);
  /** A re-valuation of the state already held: it is not a read of the venue, so the sync time stays. */
  const setStateRepriced = useCallback((owner: string, next: TraderState) => {
    setReads((prev) =>
      prev[owner]?.state ? { ...prev, [owner]: { ...prev[owner], state: next } } : prev,
    );
  }, []);
  const setAccountError = useCallback((owner: string, message: string) => {
    setReads((prev) => ({
      ...prev,
      [owner]: {
        state: prev[owner]?.state ?? null,
        syncedAtMs: prev[owner]?.syncedAtMs ?? null,
        error: message,
      },
    }));
  }, []);
  const [ownTags, setOwnTags] = useState<ReadonlySet<string>>(new Set());
  const [rollupSecrets, setRollupSecrets] = useState<Uint8Array[]>([]);
  const [grantUsed, setGrantUsed] = useState(false);
  // A fact about the deployment, not the wallet: once the service says it
  // has no faucet, no wallet is offered test funds again, on this page or
  // after a reload (the client remembers it per deployment).
  const [noFaucet, setNoFaucet] = useState(false);
  const ownTagsRef = useRef<Set<string>>(new Set());
  const rollupSecretsKeyRef = useRef<string | null>(null);
  const grantUsedKeyRef = useRef<string | null>(null);

  const walletKey = wallet ? wallet.address : null;
  if (walletKey !== grantUsedKeyRef.current) {
    grantUsedKeyRef.current = walletKey;
    setGrantUsed(readGrantUsed(walletKey));
  }

  const addOwnTag = useCallback((tag: string) => {
    if (!tag || ownTagsRef.current.has(tag)) return;
    ownTagsRef.current.add(tag);
    setOwnTags(new Set(ownTagsRef.current));
  }, []);

  function readRollupSecrets(): Uint8Array[] {
    if (!wallet || client.mode !== "rollup" || typeof window === "undefined") return [];
    return loadTrackedSecrets(window.localStorage, wallet.address).map((entry) =>
      hexToBytes(entry.secretHex),
    );
  }

  // Adjusting state during render (React's documented pattern for resetting
  // derived state when an input changes) rather than in an effect: this
  // store's writes all come from this hook's own callbacks below, which can
  // set state directly; only the "wallet identity changed" case needs to
  // reload it, and that is exactly what this key comparison catches.
  const rollupSecretsKey = wallet ? `${wallet.address}:${client.mode}` : null;
  if (rollupSecretsKey !== rollupSecretsKeyRef.current) {
    rollupSecretsKeyRef.current = rollupSecretsKey;
    setRollupSecrets(readRollupSecrets());
  }

  useEffect(() => {
    if (!wallet) return;
    const identity = wallet;
    let active = true;
    const unsubscribe = client.subscribe(
      identity,
      (next) => {
        if (!active) return;
        setStateSynced(identity.address, next);
        for (const order of next.openOrders) addOwnTag(order.tag);
      },
      (error) => {
        if (active)
          setAccountError(identity.address, error.message || "Could not read the account");
      },
    );
    return () => {
      active = false;
      unsubscribe();
      // Wallet changed (cleared, switched) or this component is going away:
      // end the wallet's own live subscription and background refreshes,
      // never left running for a wallet no longer in view.
      client.closeWallet?.(identity);
    };
  }, [client, wallet, addOwnTag, setStateSynced, setAccountError]);

  useEffect(() => {
    if (!wallet || !client.knownNoFaucet) return;
    let current = true;
    client.knownNoFaucet().then(
      (known) => {
        if (current && known) setNoFaucet(true);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, wallet]);

  // The owner's account and order keys, keyed by address like `reads`, so a
  // late answer for a wallet no longer in view writes only its own entry.
  const [flows, setFlows] = useState<Record<string, OwnerFlow>>({});
  const [statusReads] = useState(createLatestReads);
  const currentOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    currentOwnerRef.current = wallet?.address ?? null;
  }, [wallet]);
  const patchFlow = useCallback((owner: string, patch: Partial<OwnerFlow>) => {
    setFlows((prev) => ({ ...prev, [owner]: { ...(prev[owner] ?? NO_FLOW), ...patch } }));
  }, []);

  // A disconnect or a switch to another wallet forgets the last open-account
  // answer for the wallet leaving, so coming back never shows a stale error.
  useEffect(() => {
    if (!walletKey) return;
    return () => setFlows((prev) => withoutOpenOutcome(prev, walletKey));
  }, [walletKey]);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    const stopKeys = client.subscribeOrderKeys?.(wallet, (keys) => {
      if (active) patchFlow(wallet.address, { keys });
    });
    const ticket = statusReads.begin(wallet.address);
    client.accountStatus?.(wallet).then(
      (status) => {
        if (active && statusReads.isCurrent(wallet.address, ticket, wallet.address)) {
          patchFlow(wallet.address, { status });
        }
      },
      () => {},
    );
    client.makersListedMarkets?.(wallet).then(
      (makersListed) => {
        if (active) patchFlow(wallet.address, { makersListed });
      },
      () => {},
    );
    return () => {
      active = false;
      stopKeys?.();
    };
  }, [client, wallet, patchFlow, statusReads]);

  /** Runs the account check again, and with it the sign-in and key setup a failed attempt left undone. */
  const recheckAccount = useCallback(async (): Promise<void> => {
    if (!wallet || !client.accountStatus) return;
    const owner = wallet.address;
    const ticket = statusReads.begin(owner);
    const status = await client.accountStatus(wallet).catch((): AccountStatus => "unknown");
    if (!statusReads.isCurrent(owner, ticket, currentOwnerRef.current)) return;
    patchFlow(owner, { status });
    // A failed check says the session could not be built; reading the markets
    // would build another and could prompt the wallet again unasked.
    if (status === "unknown") return;
    client.makersListedMarkets?.(wallet).then(
      (makersListed) => {
        if (currentOwnerRef.current === owner) patchFlow(owner, { makersListed });
      },
      () => {},
    );
  }, [client, wallet, patchFlow, statusReads]);

  // The page itself unloading (close, refresh, navigate away) does not
  // always run the effect cleanup above in time; this ends the same
  // subscription from the one event guaranteed to fire first.
  useEffect(() => {
    if (!wallet || typeof window === "undefined") return;
    const identity = wallet;
    const onUnload = () => client.closeWallet?.(identity);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [client, wallet]);

  const flow = (wallet ? flows[wallet.address] : undefined) ?? NO_FLOW;
  const currentRead = wallet ? reads[wallet.address] : undefined;
  const effectiveState = currentRead?.state ?? EMPTY_STATE;
  const effectiveLastSyncedAtMs = currentRead?.syncedAtMs ?? null;

  // The collateral's available figure is priced from marks that go stale
  // (the UI treats it as unknown from then on), and the venue pushes a view
  // only when the seat changes. Re-reading just after that moment prices it
  // again from the marks as they are now.
  const marginValidUntilMs = effectiveState.collateral?.availableValidUntilMs;
  useEffect(() => {
    if (!wallet || marginValidUntilMs === undefined) return;
    let active = true;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const arm = (lastReadAtMs: number | null) => {
      const delay = nextMarginRefreshDelayMs(marginValidUntilMs, Date.now(), lastReadAtMs);
      refresh = setTimeout(() => {
        const readAtMs = Date.now();
        client.fetchState(wallet).then(
          (next) => {
            if (!active) return;
            setStateSynced(wallet.address, next);
            const nextValidUntilMs = next.collateral?.availableValidUntilMs;
            if (nextValidUntilMs === undefined || nextValidUntilMs <= marginValidUntilMs) {
              arm(readAtMs);
            }
          },
          () => {
            if (active) arm(readAtMs);
          },
        );
      }, delay);
    };
    arm(null);
    return () => {
      active = false;
      clearTimeout(refresh);
    };
  }, [client, wallet, marginValidUntilMs, setStateSynced]);

  // The scheduled re-read above is a backstop that belongs to a known
  // figure. While the figure is unknown it is not running, so this keeps
  // trying: re-value from the last view first, read the venue if that still
  // cannot price it.
  const figureUnknown = effectiveState.collateral?.availableUnknown === true;
  useEffect(() => {
    if (!wallet || !figureUnknown) return;
    let active = true;
    let reading = false;
    const retry = setInterval(() => {
      const repriced = client.repriceState?.(wallet);
      if (repriced && repriced.collateral?.availableUnknown !== true) {
        setStateRepriced(wallet.address, repriced);
        return;
      }
      if (reading) return;
      reading = true;
      client.fetchState(wallet).then(
        (next) => {
          reading = false;
          if (active) setStateSynced(wallet.address, next);
        },
        () => {
          reading = false;
        },
      );
    }, MARGIN_REFRESH_STALE_RETRY_MS);
    return () => {
      active = false;
      clearInterval(retry);
    };
  }, [client, wallet, figureUnknown, setStateSynced, setStateRepriced]);

  // A newer live mark for a market the account has exposure in re-values it
  // from the last view held, with no read: the available figure then moves
  // with the mark the order form sizes from. Bursts are coalesced and spaced.
  const exposureRef = useRef<Pick<TraderState, "positions" | "openOrders">>(EMPTY_STATE);
  useEffect(() => {
    exposureRef.current = effectiveState;
  }, [effectiveState]);
  useEffect(() => {
    if (!wallet || !subscribeMarks) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRepricedAtMs: number | null = null;
    const stop = subscribeMarks((marketIds) => {
      if (timer !== undefined || !hasExposureIn(exposureRef.current, marketIds)) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          lastRepricedAtMs = Date.now();
          const repriced = client.repriceState?.(wallet);
          if (repriced) setStateRepriced(wallet.address, repriced);
        },
        markRepriceDelayMs(Date.now(), lastRepricedAtMs),
      );
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, wallet, subscribeMarks, setStateRepriced]);

  const openAccount = useCallback(
    async (invite?: string): Promise<OpenAccountOutcome> => {
      if (!wallet) return { kind: "notSent", reason: "No wallet is connected." };
      patchFlow(wallet.address, { opening: true });
      let outcome: OpenAccountOutcome;
      try {
        outcome = await client.openAccount(wallet, invite);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The account could not be opened.";
        outcome = { kind: "notSent", reason: redactToken(reason) };
      }
      const nowOpen = outcome.kind === "opened" || outcome.kind === "alreadyOpen";
      if (nowOpen) statusReads.begin(wallet.address);
      patchFlow(wallet.address, {
        opening: false,
        outcome,
        ...(nowOpen ? { status: "open" as const } : {}),
      });
      return outcome;
    },
    [client, wallet, patchFlow, statusReads],
  );

  const rollupReader = useMemo(() => {
    const read = client.rollupReader?.bind(client);
    return wallet && read ? () => read(wallet) : null;
  }, [client, wallet]);

  const fund = useCallback(async (): Promise<FundOutcome> => {
    if (!wallet) return { kind: "error", message: "No wallet to fund" };
    const outcome = await client.fund(wallet);
    if (outcome.kind === "granted" || outcome.kind === "alreadyFunded") {
      writeGrantUsed(wallet.address);
      setGrantUsed(true);
    }
    if (outcome.kind === "noFaucet") setNoFaucet(true);
    return outcome;
  }, [client, wallet]);

  const placeOrder = useCallback(
    async (draft: NewOrderInput): Promise<PlacedOrderOutcome> => {
      if (!wallet) throw new Error("No wallet to trade with");
      const clickedAt = performance.now();
      const result = await client.placeOrder(wallet, draft);
      // Rollup mode reports exactly when its result was read from the view
      // (performance.now(), the same clock as clickedAt), which is more
      // precise than timing the whole call from out here: that would also
      // count this function's own promise-resolution overhead.
      const clientDurationMs =
        result.resultAtMs !== undefined
          ? result.resultAtMs - clickedAt
          : performance.now() - clickedAt;
      addOwnTag(result.tag);
      setRollupSecrets(readRollupSecrets());
      void client.makersListedMarkets?.(wallet).then(
        (makersListed) => patchFlow(wallet.address, { makersListed }),
        () => {},
      );
      // Rollup mode pushes the state an order leaves behind with the result
      // itself; dev mode only polls, so it is asked once, without waiting.
      if (client.mode === "dev") {
        void client.fetchState(wallet).then(
          (next) => setStateSynced(wallet.address, next),
          () => {},
        );
      }
      return { result, clientDurationMs };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readRollupSecrets closes over wallet/client, already deps
    [client, wallet, addOwnTag, setStateSynced, patchFlow],
  );

  const releaseUnknownOutcome = useCallback(
    (market: string, tag?: string) => {
      if (wallet) client.releaseUnknownOutcome?.(wallet, market, tag);
    },
    [client, wallet],
  );

  const readUnknownOutcome = useCallback(
    async (market: string) => {
      if (!wallet || !client.readUnknownOutcome) return null;
      return client.readUnknownOutcome(wallet, market);
    },
    [client, wallet],
  );

  const cancelAllInMarket = useCallback(
    async (market: string): Promise<CancelResult> => {
      if (!wallet) throw new Error("No wallet to cancel for");
      return client.cancelAllInMarket(wallet, market);
    },
    [client, wallet],
  );

  const syncMarket = useCallback(
    async (market: string) => {
      if (!wallet || !client.syncMarket) return;
      await client.syncMarket(wallet, market);
    },
    [client, wallet],
  );

  const cancelOrder = useCallback(
    async (market: string, orderId: string): Promise<CancelResult> => {
      if (!wallet) throw new Error("No wallet to cancel for");
      if (!client.cancelOrder) throw new Error("Per-order cancel is not available");
      return client.cancelOrder(wallet, market, orderId);
    },
    [client, wallet],
  );

  const checkPrivacy = useCallback(
    async (market: string) => {
      if (!wallet || !client.checkPrivacy) return null;
      return client.checkPrivacy(wallet, market);
    },
    [client, wallet],
  );

  const transferBetweenBalances = useCallback(
    async (toSpot: boolean, amount: string): Promise<TransferResult> => {
      if (!wallet) return { kind: "error", message: "No wallet to transfer for" };
      if (!client.transferBetweenBalances) {
        return { kind: "error", message: "Transfer is not available in this mode" };
      }
      const result = await client.transferBetweenBalances(wallet, toSpot, amount);
      if (result.kind === "ok") {
        const next = await client.fetchState(wallet);
        setStateSynced(wallet.address, next);
      }
      return result;
    },
    [client, wallet, setStateSynced],
  );

  return {
    client,
    state: effectiveState,
    accountError: currentRead?.error ?? null,
    accountLoaded: !!currentRead?.state,
    lastSyncedAtMs: effectiveLastSyncedAtMs,
    ownTags,
    rollupSecrets,
    grantUsed,
    noFaucet,
    /** Mainnet: the connected owner has no account yet and opens it through the invite list, by address or with an invite code. */
    needsInvite: isMainnetBuild() && flow.status === "absent",
    // Only a successful account read for this owner moves this off "unknown":
    // state on the stream may be a placeholder for an account never seen.
    accountStatus: flow.status,
    /** True from the moment the open request starts until it is settled. */
    opening: flow.opening,
    /** What the last attempt to open the account came to; null before any. */
    openOutcome: flow.outcome,
    openAccount,
    recheckAccount,
    /** Reads the rollup as the owner; null in dev mode and with no wallet. */
    rollupReader,
    /** Where the order keys stand on this device (waiting to replace old keys, installing, ready); null until known. */
    orderKeys: flow.keys,
    /** Symbols of the markets where only listed makers may rest orders; a Limit there is sent as immediate-or-cancel. */
    makersListed: flow.makersListed,
    fund,
    placeOrder,
    releaseUnknownOutcome,
    readUnknownOutcome,
    cancelAllInMarket,
    syncMarket,
    cancelOrder: client.cancelOrder ? cancelOrder : null,
    transferBetweenBalances: client.transferBetweenBalances ? transferBetweenBalances : null,
    checkPrivacy: client.checkPrivacy ? checkPrivacy : null,
  };
}
