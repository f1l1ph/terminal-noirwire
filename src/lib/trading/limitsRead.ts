import { createLatestReads } from "./latestRead";
import type { MarketLimits } from "./types";
import type { LimitsState } from "./uiRules";

/** What the form knows about the market limits right now. */
export interface LimitsView {
  limits: ReadonlyMap<string, MarketLimits>;
  limitsState: LimitsState;
}

const NO_LIMITS: ReadonlyMap<string, MarketLimits> = new Map();

/**
 * Reads of the market limits, one generation of the session at a time. Starting
 * a read drops what was known at once (so nothing is ordered against limits of
 * an earlier session) and only the newest read's answer, or failure, is kept:
 * an older session's late answer cannot bring its limits back.
 */
export function createLimitsReads(apply: (owner: string, view: LimitsView) => void) {
  const reads = createLatestReads();
  return {
    /** `currentOwner` says who is connected when an answer lands, so an owner who has left gets nothing. */
    start(
      owner: string,
      read: () => Promise<ReadonlyMap<string, MarketLimits>>,
      currentOwner: () => string | null,
      onFailed?: () => void,
    ): void {
      const ticket = reads.begin(owner);
      const current = () => reads.isCurrent(owner, ticket, currentOwner());
      apply(owner, { limits: NO_LIMITS, limitsState: "loading" });
      read().then(
        (limits) => {
          if (current()) apply(owner, { limits, limitsState: "ready" });
        },
        () => {
          if (!current()) return;
          apply(owner, { limits: NO_LIMITS, limitsState: "failed" });
          onFailed?.();
        },
      );
    },
  };
}
