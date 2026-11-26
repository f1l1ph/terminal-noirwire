import { readChoice, writeChoice, type ChoiceStorage } from "./persistedStore";

/**
 * Whether the trader has switched the privacy tools on (the public tape, the
 * privacy check, order timing and the private order log). Off by default and
 * remembered per browser.
 */
export const PRIVACY_TOOLS_STORAGE_KEY = "noirwire-terminal-privacy-tools";

export function loadPrivacyTools(storage: ChoiceStorage | null): boolean {
  return readChoice(storage, PRIVACY_TOOLS_STORAGE_KEY, (raw) => raw === "on", false);
}

export function savePrivacyTools(storage: ChoiceStorage | null, on: boolean): void {
  writeChoice(storage, PRIVACY_TOOLS_STORAGE_KEY, () => (on ? "on" : "off"));
}
