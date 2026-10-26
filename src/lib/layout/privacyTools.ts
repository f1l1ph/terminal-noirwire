/**
 * Whether the trader has switched the privacy tools on (the public tape, the
 * privacy check, order timing and the private order log). Off by default and
 * remembered per browser; storage access is injected so every rule here is
 * testable without a browser, and a storage that throws only means the choice
 * is not remembered.
 */
export const PRIVACY_TOOLS_STORAGE_KEY = "noirwire-terminal-privacy-tools";

export interface PrivacyToolsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPrivacyTools(storage: PrivacyToolsStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(PRIVACY_TOOLS_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function savePrivacyTools(storage: PrivacyToolsStorage | null, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(PRIVACY_TOOLS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The choice still holds for this session; it is just not remembered.
  }
}
