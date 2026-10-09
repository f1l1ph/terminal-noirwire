import type { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { decodeExchangeAccount, programAddresses } from "./sdk";

/**
 * A spot wallet balance (`Seat.spot[tokenIndex]`) is raw atoms at that
 * token's own decimals, not the 6-decimal "sim scale" nUSD and lots use. The
 * program's accounts carry a token index into `Exchange.tokens`, which names
 * a mint but not its decimals, so decimals come from the mint account itself
 * (hence the `@solana/spl-token` dependency). Read once per program id and
 * cached: decimals never change for an existing mint.
 */
export class MintDecimalsCache {
  private readonly exchangeAddress: PublicKey;
  private byTokenIndex = new Map<number, Promise<number>>();

  constructor(
    private readonly connection: Connection,
    programId: PublicKey,
  ) {
    this.exchangeAddress = programAddresses(programId).exchange;
  }

  async decimalsOf(tokenIndex: number): Promise<number> {
    const cached = this.byTokenIndex.get(tokenIndex);
    if (cached) return cached;
    const promise = this.load(tokenIndex);
    this.byTokenIndex.set(tokenIndex, promise);
    return promise;
  }

  private async load(tokenIndex: number): Promise<number> {
    const account = await this.connection.getAccountInfo(this.exchangeAddress);
    if (!account) throw new Error("the exchange account is not readable here");
    const exchange = decodeExchangeAccount(account.data);
    const token = exchange.tokens[tokenIndex];
    if (!token) throw new Error(`no token at index ${tokenIndex}`);
    const mint = await getMint(this.connection, token.mint);
    return mint.decimals;
  }
}
