"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Keypair } from "@solana/web3.js";
import { env } from "@/lib/env";
import { isMainnetBuild } from "@/lib/network";
import { mainnetOwnerSigner } from "@/lib/rollup/mainnetOwner";
import { questStatus, type QuestStatus } from "@/lib/quests/device";
import { dismissInvite, inviteShown, recordInvite } from "@/lib/quests/invite";
import {
  disableQuests,
  enableQuests,
  QuestOptInError,
  QUESTS_UNAVAILABLE,
} from "@/lib/quests/optIn";
import { browserQuestDeps, sharedQuestQueue } from "@/lib/quests/shared";
import { browserLocalStorage, hexToBytes } from "@/lib/wallet/index";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import { useStandardWallet } from "@/lib/wallet/standardWallet";
import { useWallet } from "@/lib/wallet/useWallet";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useQuestSigner(): OwnerSigner | null {
  const { signer: connected } = useStandardWallet();
  const account = useWallet().account;
  return useMemo(() => {
    if (isMainnetBuild()) {
      return connected && env.solanaRpcUrl ? mainnetOwnerSigner(connected, env.solanaRpcUrl) : null;
    }
    return account
      ? keypairOwnerSigner(Keypair.fromSecretKey(hexToBytes(account.secretKeyHex)))
      : null;
  }, [connected, account]);
}

export function useQuestInvite(owner: string | null): { visible: boolean; dismiss: () => void } {
  const signer = useQuestSigner();
  const invited = useSyncExternalStore(
    subscribe,
    () => inviteShown(browserLocalStorage()),
    () => false,
  );
  useEffect(() => {
    recordInvite(browserLocalStorage(), window.location.search);
    notify();
  }, []);
  const dismiss = useCallback(() => {
    dismissInvite(browserLocalStorage());
    notify();
  }, []);
  return { visible: invited && owner !== null && signer !== null, dismiss };
}

export function useQuestFlush(owner: string | null): void {
  useEffect(() => {
    if (!owner) return;
    const queue = sharedQuestQueue(env.simUrl);
    const run = () => void queue.flush(owner, true);
    run();
    window.addEventListener("online", run);
    window.addEventListener("focus", run);
    return () => {
      window.removeEventListener("online", run);
      window.removeEventListener("focus", run);
    };
  }, [owner]);
}

export function useQuestSwitch(owner: string | null): {
  status: QuestStatus;
  busy: boolean;
  error: string | null;
  toggle: () => void;
} {
  const signer = useQuestSigner();
  const status = useSyncExternalStore(
    subscribe,
    () => (owner ? questStatus(browserLocalStorage(), owner, Date.now()) : "off"),
    () => "off" as const,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback(() => {
    if (!owner || !signer || busy) return;
    const deps = browserQuestDeps(env.simUrl);
    setError(null);
    setBusy(true);
    const work =
      status === "on"
        ? disableQuests(deps, owner).then(() => undefined)
        : enableQuests({ ...deps, signer }).then(() => undefined);
    work
      .catch((reason: unknown) =>
        setError(reason instanceof QuestOptInError ? reason.message : QUESTS_UNAVAILABLE),
      )
      .finally(() => {
        setBusy(false);
        notify();
      });
  }, [owner, signer, busy, status]);
  return { status, busy, error, toggle };
}
