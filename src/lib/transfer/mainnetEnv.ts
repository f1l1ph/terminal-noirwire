import { PublicKey, type Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { MAINNET_PINS } from "../rollup/pins";
import type { KeyWithdrawal } from "../trading/types";
import { rememberToken } from "../rollup/redact";
import { QUOTE_DECIMALS } from "../rollup/markets";
import { isMainnetOwnerSigner } from "../rollup/mainnetOwner";
import { signChecked } from "../rollup/ownerSend";
import {
  connectWithToken,
  decodeExchangeAccount,
  programAddresses,
  signInWithExpiry,
  type CustodyToken,
} from "../rollup/sdk";
import type { OwnerSigner } from "../wallet/ownerSigner";
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

export interface MainnetTransferParts {
  /** The owner signer the trading path uses: the one `mainnetOwnerSigner` made, with the network check in front of every signature. */
  signer: OwnerSigner;
  solana: SolanaRpc;
  /** The rollup connection of the trading session, signed in as the owner. */
  rollup: SolanaRpc;
  /** Where the trading session's `rollup` connection points, which may carry its sign-in token: the deposit key signs in at the same rollup, without the token. */
  rollupEndpoint: string;
  /** The owner's deposit key, already stored on this browser (`loadOrCreateDepositKey`). */
  depositKey: Keypair;
  /** The rollup connection signed in as the deposit key; by default the key signs in itself, once, with no wallet. Tests pass their own. */
  depositRollup?: () => Promise<SolanaRpc>;
  /** Whether the owner has an open account on the exchange, as the trading session reads it. */
  accountOpen(): Promise<boolean>;
  /** Given only where the deployment takes the owner's consent as a signed message: the seat's withdrawal is then signed by an order key and the wallet signs no rollup transaction. */
  withdrawByKey?: (atoms: bigint) => Promise<KeyWithdrawal>;
  /** Reads the Exchange account; by default from `rollup`. Tests pass their own. */
  readExchange?: () => Promise<ExchangeFacts>;
  journal?: Journal;
  clock?: Clock;
  newId?: () => string;
}

/** The rollup's address with any query (the sign-in token) and trailing slash removed. */
export function rollupBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The rollup signed in as `key`: its own signature answers the endpoint's challenge, and the connection is made once and kept. */
function signedInAsKey(key: Keypair, rollupRpcUrl: string): () => Promise<SolanaRpc> {
  let session: Promise<SolanaRpc> | null = null;
  const signIn = async () => {
    const { token } = await signInWithExpiry(rollupRpcUrl, key.publicKey, async (message) =>
      nacl.sign.detached(message, key.secretKey),
    );
    rememberToken(token);
    return connectWithToken(rollupRpcUrl, token);
  };
  return () =>
    (session ??= signIn().catch((error: unknown) => {
      session = null;
      throw error;
    }));
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
    depositKey: parts.depositKey,
    depositRollup:
      parts.depositRollup ?? signedInAsKey(parts.depositKey, rollupBaseUrl(parts.rollupEndpoint)),
    exchange: port,
    withdrawByKey: parts.withdrawByKey,
    journal: parts.journal ?? createJournal(indexedDbStorage()),
    lock: (owner) => tryLockOwner(owner),
    signChecked: (transaction, chain) => signChecked(parts.signer, transaction, chain),
    clock: parts.clock ?? browserClock,
    newId: parts.newId ?? (() => crypto.randomUUID()),
  });
}
