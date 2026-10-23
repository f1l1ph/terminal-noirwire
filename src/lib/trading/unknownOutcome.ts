/**
 * An order that may have reached the venue, with nothing to prove whether it
 * ran. `secretHex` names the order (its fills are recognised by it), so the
 * terminal can hold the form until that is settled instead of letting a
 * second, real order be signed.
 */
export class OrderOutcomeUnknownError extends Error {
  constructor(readonly secretHex: string) {
    super("Order outcome unknown. Check open orders and positions before retrying.");
    this.name = "OrderOutcomeUnknownError";
  }
}
