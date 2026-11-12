import type { KeyValueStore } from "../wallet/index";
import type { QuestStatus } from "./device";

const INVITED_KEY = "noirwire-terminal-quests-invited";
const DISMISSED_KEY = "noirwire-terminal-quests-dismissed";

export function recordInvite(storage: KeyValueStore, search: string): void {
  try {
    if (new URLSearchParams(search).get("from") !== "quests") return;
    storage.setItem(INVITED_KEY, "1");
    storage.removeItem(DISMISSED_KEY);
  } catch {
    return;
  }
}

export function inviteDismissed(storage: KeyValueStore): boolean {
  try {
    return storage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return true;
  }
}

export function shouldOpenQuestDialog({
  dismissed,
  status,
}: {
  dismissed: boolean;
  status: QuestStatus;
}): boolean {
  return !dismissed && status !== "on";
}

export function dismissInvite(storage: KeyValueStore): void {
  try {
    storage.setItem(DISMISSED_KEY, "1");
  } catch {
    return;
  }
}
