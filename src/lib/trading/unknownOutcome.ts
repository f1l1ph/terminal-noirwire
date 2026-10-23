import type { UnknownHold } from "../rollup/accountMemory";

/**
 * An order that may have reached the venue, with nothing to prove whether it
 * ran. `hold` is its record (its fill identifier, what was sent and when), so
 * the terminal can hold the form until that is settled instead of letting a
 * second, real order be signed.
 */
export class OrderOutcomeUnknownError extends Error {
  constructor(readonly hold: UnknownHold) {
    super("Order outcome unknown. Check open orders and positions before retrying.");
    this.name = "OrderOutcomeUnknownError";
  }

  get secretHex(): string {
    return this.hold.tag;
  }
}
