import {
  DELEGATION_PROGRAM_ID,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey, Transaction, type AccountInfo } from "@solana/web3.js";
import { programAddresses } from "@/lib/rollup/sdk";
import type { KeyWithdrawal } from "@/lib/trading/types";
import { depositKeyAccount, depositKeyBalance } from "@/lib/transfer/depositKey";
import { createJournal, type JournalStorage, type OperationRecord } from "@/lib/transfer/journal";
import { tryLockOwner, type LockManagerLike } from "@/lib/transfer/lock";
import {
  balanceAccount,
  createTransferEnv,
  walletAccount,
  type TransferEnv,
} from "@/lib/transfer/operation";
import { signatureOf } from "@/lib/transfer/send";
import type { SolanaRpc } from "@/lib/transfer/solanaRpc";

export const USDC = 1_000_000n;

const tokenAccount = (amount: bigint): AccountInfo<Buffer> => {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { data, executable: false, lamports: 2_039_280, owner: PublicKey.unique(), rentEpoch: 0 };
};

/** How a fake node treats the next transaction it is sent. */
export type Fate =
  /** It lands and the node answers. */
  | "land"
  /** It lands but the answer is lost. */
  | "land-lost"
  /** The node takes it and never includes it. */
  | "swallow"
  /** The node runs it and it fails. */
  | "fail";

interface Plan {
  fate: Fate;
  effect?: () => void;
  /** How far the node has taken it when it lands; finalized unless said. */
  commitment?: "confirmed" | "finalized";
}

export class FakeRpc implements SolanaRpc {
  accounts = new Map<string, AccountInfo<Buffer>>();
  statuses = new Map<string, { err: unknown; confirmationStatus?: string } | null>();
  height = 1_000;
  lamports = 1_000_000_000;
  sent: string[] = [];
  rawSent: Uint8Array[] = [];
  simulations = 0;
  simulateAnswers: unknown[] = [];
  private plans: Plan[] = [];

  constructor(
    private readonly name: string,
    private readonly events: string[],
  ) {}

  script(...plans: Plan[]) {
    this.plans.push(...plans);
  }

  setToken(address: PublicKey, amount: bigint) {
    this.accounts.set(address.toBase58(), tokenAccount(amount));
  }

  token(address: PublicKey): bigint {
    const info = this.accounts.get(address.toBase58());
    return info ? info.data.readBigUInt64LE(64) : 0n;
  }

  async getSignatureStatus(signature: string) {
    return { value: this.statuses.get(signature) ?? null };
  }

  async getSignatureStatuses(signatures: string[]) {
    return { value: signatures.map((s) => this.statuses.get(s) ?? null) };
  }

  async getBlockHeight() {
    return this.height;
  }

  async getLatestBlockhash() {
    return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: this.height + 150 };
  }

  async getAccountInfo(address: PublicKey) {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getBalance() {
    return this.lamports;
  }

  async sendRawTransaction(raw: Uint8Array) {
    const signature = signatureOf(raw);
    this.events.push(`broadcast:${this.name}`);
    this.sent.push(signature);
    this.rawSent.push(raw);
    const plan = this.plans.shift() ?? { fate: "land" };
    if (plan.fate === "land" || plan.fate === "land-lost") {
      plan.effect?.();
      this.statuses.set(signature, {
        err: null,
        confirmationStatus: plan.commitment ?? "finalized",
      });
    } else if (plan.fate === "fail") {
      this.statuses.set(signature, {
        err: { InstructionError: [0, { Custom: 6150 }] },
        confirmationStatus: "finalized",
      });
    }
    if (plan.fate === "land-lost") throw new Error("socket closed");
    return signature;
  }

  async simulateTransaction() {
    this.simulations += 1;
    const err = this.simulateAnswers.shift() ?? null;
    return { value: { err, logs: null } };
  }
}

export const staleMark = { InstructionError: [0, { Custom: 6038 }] };

export function memoryStorage() {
  const rows = new Map<string, OperationRecord>();
  const storage: JournalStorage = {
    async update(owner, id, mutate) {
      const key = `${owner}/${id}`;
      const next = mutate(rows.get(key));
      if (next === null) rows.delete(key);
      else rows.set(key, next);
    },
    async list(owner) {
      return [...rows.entries()].filter(([key]) => key.startsWith(`${owner}/`)).map(([, v]) => v);
    },
  };
  return { storage, rows };
}

/** One browser's lock manager: a name held by one request is refused to the next. */
export function browserLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({});
      } finally {
        held.delete(name);
      }
    },
  };
}

export function makeWorld(
  options: { withdrawByKey?: (atoms: bigint) => Promise<KeyWithdrawal>; depositKey?: Keypair } = {},
) {
  const events: string[] = [];
  const keyed = options.withdrawByKey;
  const keypair = Keypair.generate();
  const depositKey = options.depositKey ?? Keypair.generate();
  const clock = {
    t: 1_700_000_000_000,
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      this.t += ms;
    },
  };
  const solana = new FakeRpc("solana", events);
  const rollup = new FakeRpc("rollup", events);
  const { storage, rows } = memoryStorage();
  const real = createJournal(storage, () => clock.t);
  const journal: typeof real = {
    ...real,
    async record(owner, op) {
      await real.record(owner, op);
      events.push("journal:record");
    },
    async recordSeatSend(owner, id, seat) {
      await real.recordSeatSend(owner, id, seat);
      events.push("journal:seat");
    },
  };
  const locks = browserLocks();
  const exchangeState = {
    open: true,
    paused: false,
    custodyCap: 1_000_000_000n,
    /** How many times a withdrawal was about to be built. */
    withdrawBuilds: 0,
    marketIds: [0, 1],
  };
  const pins = {
    programId: PublicKey.unique(),
    mint: PublicKey.unique(),
    validator: PublicKey.unique(),
  };
  const token = { mint: pins.mint, custodyNonce: 7n };
  const custody = programAddresses(pins.programId).custody(token);
  let ids = 0;
  const signed: Transaction[] = [];
  const env: TransferEnv = createTransferEnv({
    owner: keypair.publicKey,
    pins,
    decimals: 6,
    sealed: false,
    solana,
    rollup,
    exchange: {
      accountOpen: async () => exchangeState.open,
      read: async () => ({ paused: exchangeState.paused, custodyCap: exchangeState.custodyCap }),
      token,
      perpMarketIds: async () => {
        exchangeState.withdrawBuilds += 1;
        return exchangeState.marketIds;
      },
    },
    withdrawByKey: keyed
      ? async (atoms) => {
          events.push("key-withdraw");
          return keyed(atoms);
        }
      : undefined,
    journal,
    lock: (owner) => tryLockOwner(owner, locks),
    depositKey,
    depositRollup: async () => rollup,
    signChecked: async (transaction) => {
      events.push("sign");
      transaction.partialSign(keypair);
      signed.push(transaction);
      return transaction;
    },
    clock,
    newId: () => `id${(ids += 1)}`,
  });

  const wallet = walletAccount(env);
  const balance = balanceAccount(env);
  const keyAccount = depositKeyAccount(depositKey.publicKey, pins.mint);
  const keyBalance = depositKeyBalance(depositKey.publicKey, pins.mint);
  const delegateTo = (
    account: PublicKey,
    tokens: PublicKey,
    amount: bigint,
    validator: PublicKey,
  ) => {
    solana.accounts.set(account.toBase58(), tokenAccount(0n));
    const data = Buffer.alloc(80);
    validator.toBuffer().copy(data, 8);
    solana.accounts.set(delegationRecordPdaFromDelegatedAccount(account).toBase58(), {
      data,
      executable: false,
      lamports: 1,
      owner: DELEGATION_PROGRAM_ID,
      rentEpoch: 0,
    });
    rollup.setToken(tokens, amount);
  };
  const world = {
    env,
    pins,
    token,
    keypair,
    depositKey,
    /** The deposit key's token account, and its balance account that is delegated to the rollup. */
    keyAccount,
    keyBalance,
    events,
    clock,
    solana,
    rollup,
    rows,
    exchange: exchangeState,
    locks,
    signed,
    wallet,
    custody,
    owner: keypair.publicKey.toBase58(),
    /** The wallet's tokens on Solana, the custody's and the owner's balance in the rollup. */
    fund({
      onSolana = 0n,
      inCustody = 0n,
      inRollup = null,
    }: {
      onSolana?: bigint;
      inCustody?: bigint;
      inRollup?: bigint | null;
    }) {
      solana.setToken(wallet, onSolana);
      rollup.setToken(custody, inCustody);
      if (inRollup !== null) world.delegate(inRollup);
    },
    /** The owner's balance is delegated to the rollup and holds `amount` there. */
    delegate(amount: bigint, validator = env.validator) {
      delegateTo(balance, wallet, amount, validator);
    },
    /** The deposit key's balance is delegated to the rollup and holds `amount` there. */
    delegateKey(amount: bigint, validator = env.validator) {
      delegateTo(keyBalance, keyAccount, amount, validator);
    },
    /** What the move into the rollup does when it lands: the wallet's tokens become the deposit key's rollup balance. */
    moveEffect(atoms: bigint) {
      return () => {
        solana.setToken(wallet, solana.token(wallet) - atoms);
        world.delegateKey(rollup.token(keyAccount) + atoms);
      };
    },
    /** What the rollup deposit does when it lands: the deposit key's balance goes to the seat. */
    depositEffect(atoms: bigint) {
      return () => rollup.setToken(keyAccount, rollup.token(keyAccount) - atoms);
    },
    /** What the seat's withdrawal does when it lands. */
    seatEffect(atoms: bigint) {
      return () => rollup.setToken(wallet, rollup.token(wallet) + atoms);
    },
    /** What the token program's withdrawal does when it lands. */
    shuttleEffect(atoms: bigint) {
      return () => {
        rollup.setToken(wallet, rollup.token(wallet) - atoms);
        solana.setToken(wallet, solana.token(wallet) + atoms);
      };
    },
    record(): OperationRecord | undefined {
      return [...rows.values()][0];
    },
  };
  world.fund({ onSolana: 100n * USDC, inCustody: 0n });
  return world;
}

export type World = ReturnType<typeof makeWorld>;

/**
 * A deposit begun by an earlier version of the app, which moved the tokens into
 * the owner's own rollup balance and left the owner to sign the collateral step:
 * its move landed, and its collateral step was refused (`fail`, so only the
 * move is on record) or is still unanswered (`swallow`, so it is recorded
 * pending). Its record carries no deposit key.
 */
export async function legacyDeposit(world: World, fate: "fail" | "swallow", atoms: bigint) {
  await world.env.journal.record(world.owner, {
    id: "old",
    kind: "deposit",
    atoms: atoms.toString(),
    step: "deposit",
    rollupBefore: "0",
    sends: [
      {
        signature: "sigA",
        lastValidBlockHeight: world.solana.height + 150,
        status: "finalized",
        before: (100n * USDC).toString(),
        moved: atoms.toString(),
      },
    ],
  });
  world.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
  world.solana.sent.push("sigA");
  world.solana.setToken(world.wallet, 100n * USDC - atoms);
  world.delegate(atoms);
  if (fate === "swallow") {
    await world.env.journal.recordSeatSend(world.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: atoms.toString(),
      signature: "sigR",
      lastValidBlockHeight: world.rollup.height + 150,
    });
    world.rollup.sent.push("sigR");
  }
  world.events.length = 0;
}
