import { PublicKey, type Transaction } from "@solana/web3.js";
import { MAINNET_PINS } from "../rollup/pins";
import { QUOTE_DECIMALS } from "../rollup/markets";
import { isMainnetOwnerSigner } from "../rollup/mainnetOwner";
import { signChecked } from "../rollup/ownerSend";
import { decodeExchangeAccount, programAddresses, type CustodyToken } from "../rollup/sdk";
import type { MainnetChain, OwnerSigner } from "../wallet/ownerSigner";
import type { TransferPins } from "./guard";
import { createJournal, indexedDbStorage, type Journal } from "./journal";
import { tryLockOwner } from "./lock";
import { createTransferEnv, type ExchangePort, type TransferEnv } from "./operation";
import type { Clock, SolanaRpc } from "./solanaRpc";

/** The program, the token and the rollup validator a mainnet build moves money through, from the pins and nothing else. */
export function mainnetTransferPins(): TransferPins {
  return {
    programId: new PublicKey(MAINNET_PINS.programId),
    mint: new PublicKey(MAINNET_PINS.usdcMint),
    validator: new PublicKey(MAINNET_PINS.validator),
  };
}

export interface ExchangeFacts {
  paused: boolean;
  custodyCap: bigint;
  sealed: boolean;
  token: CustodyToken;
  perpMarketIds: number[];
}

/** The Exchange account as the transfers need it, read fresh each time from the pinned program's own address. */
export async function readExchange(
  reader: Pick<SolanaRpc, "getAccountInfo">,
): Promise<ExchangeFacts> {
  const address = programAddresses(mainnetTransferPins().programId).exchange;
  const account = await reader.getAccountInfo(address, "confirmed");
  if (!account) throw new Error("the exchange account is not readable here");
  const exchange = decodeExchangeAccount(account.data);
  const collateral = exchange.tokens[exchange.collateralToken];
  if (!collateral) throw new Error("the exchange account names no collateral token");
  const perpMarketIds: number[] = [];
  for (let id = 0; id < 32; id += 1) if ((exchange.perpMarkets >>> id) & 1) perpMarketIds.push(id);
  return {
    paused: exchange.paused,
    custodyCap: collateral.custodyCap,
    sealed: collateral.custodyVisibility === "sealed",
    token: { mint: collateral.mint, custodyNonce: collateral.custodyNonce },
    perpMarketIds,
  };
}

/**
 * The chain the wallet is told about: a transaction for the order book program
 * is a rollup transaction and is signed with no chain; every other transfer
 * transaction is a Solana mainnet one.
 */
export function chainOf(transaction: Transaction, programId: PublicKey): MainnetChain | undefined {
  return transaction.instructions.some((instruction) => instruction.programId.equals(programId))
    ? undefined
    : "solana:mainnet";
}

export interface MainnetTransferParts {
  /** The owner signer the trading path uses: the one `mainnetOwnerSigner` made, with the network check in front of every signature. */
  signer: OwnerSigner;
  solana: SolanaRpc;
  /** The rollup connection of the trading session, signed in as the owner. */
  rollup: SolanaRpc;
  /** Whether the owner has an open account on the exchange, as the trading session reads it. */
  accountOpen(): Promise<boolean>;
  /** Reads the Exchange account; by default from `rollup`. Tests pass their own. */
  readExchange?: () => Promise<ExchangeFacts>;
  journal?: Journal;
  clock?: Clock;
  newId?: () => string;
}

const browserClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The env the deposit and withdraw flows run in on mainnet. Everything that
 * decides where money goes is pinned in code: the program, the USDC mint and
 * the rollup validator, with the token's decimals; the exchange's collateral
 * token must be that mint (`createTransferEnv` refuses otherwise). The owner
 * signs only through the guarded signer, and every signature is checked with
 * `signedDiffers` (inside `signChecked`) after the flow has compared the
 * transaction with the one it means to send. A signer that is not the guarded
 * one is refused outright.
 */
export async function createMainnetTransferEnv(parts: MainnetTransferParts): Promise<TransferEnv> {
  if (!isMainnetOwnerSigner(parts.signer)) {
    throw new Error("Transfers sign only through the network-checked wallet signer.");
  }
  const pins = mainnetTransferPins();
  const readFresh = parts.readExchange ?? (() => readExchange(parts.rollup));
  const exchange = await readFresh();
  const port: ExchangePort = {
    accountOpen: parts.accountOpen,
    read: async () => {
      const fresh = await readFresh();
      return { paused: fresh.paused, custodyCap: fresh.custodyCap };
    },
    token: exchange.token,
    perpMarketIds: async () => (await readFresh()).perpMarketIds,
  };
  return createTransferEnv({
    owner: parts.signer.publicKey,
    pins,
    decimals: QUOTE_DECIMALS,
    sealed: exchange.sealed,
    solana: parts.solana,
    rollup: parts.rollup,
    exchange: port,
    journal: parts.journal ?? createJournal(indexedDbStorage()),
    lock: (owner) => tryLockOwner(owner),
    signChecked: (transaction) =>
      signChecked(parts.signer, transaction, chainOf(transaction, pins.programId)),
    clock: parts.clock ?? browserClock,
    newId: parts.newId ?? (() => crypto.randomUUID()),
  });
}
