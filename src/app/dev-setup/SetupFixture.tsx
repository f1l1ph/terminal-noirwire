"use client";

import { useState } from "react";
import { AccountSetup } from "@/components/AccountSetup";
import type { AccountStatus, OpenAccountOutcome, OrderKeyState } from "@/lib/trading/types";

interface Scene {
  address: string | null;
  status: AccountStatus;
  needsInvite: boolean;
  outcome: OpenAccountOutcome | null;
  keys: OrderKeyState | null;
  funded: boolean | null;
}

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const START: Scene = {
  address: null,
  status: "unknown",
  needsInvite: false,
  outcome: null,
  keys: null,
  funded: null,
};

const CONNECTED: Scene = { ...START, address: ADDRESS };
const DECLINED: Scene = { ...CONNECTED, status: "declined" };
const ABSENT: Scene = { ...CONNECTED, status: "absent", needsInvite: true };
const REFUSED: Scene = {
  ...ABSENT,
  outcome: { kind: "refused", refusal: { kind: "notInvited" } },
};
const OPEN: Scene = { ...CONNECTED, status: "open" };
const KEYS_FAILED: Scene = {
  ...OPEN,
  keys: {
    stage: "failed",
    reason: "This browser would not store the trading keys.",
    failure: "key_storage_unavailable",
    seedPersisted: true,
  },
};
const KEYS_READY: Scene = { ...OPEN, keys: { stage: "ready", seedPersisted: true } };
const DEPOSIT: Scene = { ...KEYS_READY, funded: false };

const SCENES: readonly { label: string; scene: Scene }[] = [
  { label: "Scene: not connected", scene: START },
  { label: "Scene: connected, status unknown", scene: CONNECTED },
  { label: "Scene: declined", scene: DECLINED },
  { label: "Scene: absent, invite needed", scene: ABSENT },
  { label: "Scene: open refused, not invited", scene: REFUSED },
  { label: "Scene: open", scene: OPEN },
  { label: "Scene: keys failed", scene: KEYS_FAILED },
  { label: "Scene: keys ready", scene: KEYS_READY },
  { label: "Scene: deposit step", scene: DEPOSIT },
];

/** The mainnet account setup on a page a test build can reach, stepped through its states by buttons. */
export function SetupFixture() {
  const [scene, setScene] = useState<Scene>(START);
  return (
    <main className="bg-base text-ink mx-auto flex min-h-dvh max-w-sm flex-col gap-4 p-3">
      <AccountSetup
        address={scene.address}
        status={scene.status}
        needsInvite={scene.needsInvite}
        opening={false}
        outcome={scene.outcome}
        onOpen={() => setScene(REFUSED)}
        onRecheck={async () => {}}
        keys={scene.keys}
        now={0}
        funded={scene.funded}
        depositsOpen
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Fixture controls">
        {SCENES.map((item) => (
          <button
            key={item.label}
            type="button"
            className="border-line text-ink min-h-9 rounded border px-2 text-[11px]"
            onClick={() => setScene(item.scene)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </main>
  );
}
