"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { StaleSigner, type OwnerSigner } from "./ownerSigner";

const MAINNET = "solana:mainnet";
const PUBLIC_KEY_BYTES = 32;

type ConnectFeature = StandardConnectFeature[typeof StandardConnect];
type DisconnectFeature = StandardDisconnectFeature[typeof StandardDisconnect];
type EventsFeature = StandardEventsFeature[typeof StandardEvents];
type SignTransactionFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];
type SignMessageFeature = SolanaSignMessageFeature[typeof SolanaSignMessage];

const featureOf = <T,>(wallet: Wallet, name: string) =>
  (wallet.features as Record<string, unknown>)[name] as T | undefined;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The first thing a wallet lacks for this terminal, as the end of a sentence that starts with its name; null when it lacks nothing. */
function firstShortfall(wallet: Wallet): string | null {
  if (!(StandardConnect in wallet.features)) {
    return "cannot connect to a page, which this app needs";
  }
  if (!(StandardEvents in wallet.features)) {
    return "cannot report account changes, which this app needs";
  }
  if (!(SolanaSignTransaction in wallet.features)) {
    return "cannot sign transactions, which this app needs";
  }
  if (!(SolanaSignMessage in wallet.features)) {
    return "cannot sign messages, which this app needs";
  }
  if (!wallet.chains.includes(MAINNET)) return "is not on Solana mainnet";
  return null;
}

/** A wallet this terminal can use: it connects, signs a transaction and a message, and names Solana mainnet. Anything less is not listed. */
export function isUsableWallet(wallet: Wallet): boolean {
  return firstShortfall(wallet) === null;
}

const isSolanaWallet = (wallet: Wallet) =>
  wallet.chains.some((chain) => chain.startsWith("solana:")) ||
  Object.keys(wallet.features).some((feature) => feature.startsWith("solana:"));

export type RejectedWallet = { name: string; sentence: string };

/** The Solana wallets in `wallets` this terminal cannot use, each with one plain sentence saying why. Wallets for other chains are not mentioned. */
export function rejectedWallets(wallets: readonly Wallet[]): RejectedWallet[] {
  return wallets.flatMap((wallet) => {
    const shortfall = isSolanaWallet(wallet) ? firstShortfall(wallet) : null;
    return shortfall
      ? [{ name: wallet.name, sentence: `${wallet.name} was found but ${shortfall}.` }]
      : [];
  });
}

export type SessionEnd = { reason: "switched" | "locked"; address: string };

/** Why a connected session must end after the wallet reports `accounts`: null while the connected address is still among them. */
export function sessionEndReason(
  accounts: readonly Pick<WalletAccount, "address">[],
  connectedAddress: string,
): SessionEnd["reason"] | null {
  if (accounts.some((account) => account.address === connectedAddress)) return null;
  return accounts.length === 0 ? "locked" : "switched";
}

/**
 * Whether `account` can be the owner: a 32-byte key on Solana mainnet whose
 * address is exactly the canonical base58 of that key, so the address shown
 * and remembered is the key that signs.
 */
const isUsableAccount = (account: WalletAccount) =>
  account.publicKey.length === PUBLIC_KEY_BYTES &&
  account.chains.includes(MAINNET) &&
  new PublicKey(account.publicKey).toBase58() === account.address;

/**
 * The owner signer for `account`. The wallet only signs; every result is
 * checked here before it is handed on: a message is refused when the wallet
 * signed other bytes or its signature does not verify against the account's
 * key. A transaction is returned as the wallet gave it, to be checked with
 * `signedDiffers` against what was built. `generation` reads the session's
 * counter: a result that comes back after it moved (account switch,
 * disconnect, reconnect) is discarded with `StaleSigner`.
 */
export function ownerSignerFor(
  wallet: Wallet,
  account: WalletAccount,
  generation: () => number = () => 0,
): OwnerSigner {
  const signTransactionFeature = featureOf<SignTransactionFeature>(wallet, SolanaSignTransaction);
  const signMessageFeature = featureOf<SignMessageFeature>(wallet, SolanaSignMessage);
  if (!signTransactionFeature || !signMessageFeature || !isUsableAccount(account)) {
    throw new Error("the wallet cannot sign transactions and messages on Solana mainnet");
  }
  const publicKey = new PublicKey(account.publicKey);
  const born = generation();
  const stillBorn = () => {
    if (generation() !== born) throw new StaleSigner();
  };
  return {
    publicKey,
    async signMessage(message) {
      stillBorn();
      const ours = message.slice();
      const [output] = await signMessageFeature.signMessage({ account, message: message.slice() });
      stillBorn();
      if (!output || !sameBytes(output.signedMessage, ours)) {
        throw new Error("the wallet signed a message other than the one it was given");
      }
      if (!nacl.sign.detached.verify(ours, output.signature, publicKey.toBytes())) {
        throw new Error("the wallet's signature does not verify over the message");
      }
      return output.signature.slice();
    },
    async signTransaction(tx, chain) {
      stillBorn();
      const [output] = await signTransactionFeature.signTransaction({
        account,
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ...(chain === MAINNET ? { chain } : {}),
      });
      stillBorn();
      if (!output) throw new Error("the wallet signed nothing");
      return Transaction.from(output.signedTransaction);
    },
  };
}

type Connected = {
  wallet: Wallet;
  account: WalletAccount;
  signer: OwnerSigner;
  generation: number;
};
type SessionState = {
  connected: Connected | null;
  connecting: boolean;
  /** Set when the wallet ended the session (account switch or lock); never by our own Disconnect. Cleared by the next connect or by `dismissEnded`. */
  ended: SessionEnd | null;
};

const IDLE: SessionState = { connected: null, connecting: false, ended: null };
const noop = () => {};

/**
 * The connection to one wallet at a time, outside React so its ordering rules
 * can be tested. A connect that finishes after a disconnect or after a newer
 * connect is ignored; an account switch seen while a connect is still pending
 * refuses it; any switch or disconnect afterwards drops the signer.
 */
export function createWalletSession() {
  let state = IDLE;
  let attempt = 0;
  let pending: Wallet | null = null;
  let release = noop;
  const listeners = new Set<() => void>();

  const set = (next: SessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const letGo = () => {
    release();
    release = noop;
  };

  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Whether `signer` is still the connected owner: check after every await before using what it signed. */
    isCurrent: (signer: OwnerSigner) =>
      state.connected?.signer === signer && state.connected.generation === attempt,
    async connect(wallet: Wallet) {
      const feature = featureOf<ConnectFeature>(wallet, StandardConnect);
      if (!feature || !isUsableWallet(wallet)) throw new Error("this wallet cannot be used here");
      attempt += 1;
      const mine = attempt;
      letGo();
      pending = wallet;
      set({ ...IDLE, connecting: true });

      let seen: readonly WalletAccount[] | undefined;
      let chosen: WalletAccount | null = null;
      const events = featureOf<EventsFeature>(wallet, StandardEvents);
      const off =
        events?.on("change", ({ accounts }) => {
          if (attempt !== mine) return;
          if (accounts) seen = accounts;
          if (!chosen) return;
          const reason = sessionEndReason(accounts ?? wallet.accounts, chosen.address);
          if (reason || !isUsableWallet(wallet)) {
            const address = chosen.address;
            attempt += 1;
            letGo();
            set({ ...IDLE, ended: reason ? { reason, address } : null });
          }
        }) ?? noop;

      try {
        const { accounts } = await feature.connect();
        if (attempt !== mine) {
          off();
          return;
        }
        const account = accounts[0] ?? wallet.accounts[0];
        if (!account || !isUsableAccount(account)) {
          throw new Error("the wallet gave no Solana mainnet account");
        }
        if (seen && !seen.some((each) => each.address === account.address)) {
          throw new Error("the wallet switched account while connecting");
        }
        const signer = ownerSignerFor(wallet, account, () => attempt);
        chosen = account;
        release = off;
        set({
          connected: { wallet, account, signer, generation: attempt },
          connecting: false,
          ended: null,
        });
      } catch (error) {
        off();
        if (attempt === mine) set(IDLE);
        throw error;
      }
    },
    dismissEnded() {
      if (state.ended) set(IDLE);
    },
    async disconnect() {
      attempt += 1;
      const wallet = pending;
      pending = null;
      letGo();
      set(IDLE);
      if (wallet) await featureOf<DisconnectFeature>(wallet, StandardDisconnect)?.disconnect();
    },
  };
}

export type StandardWallet = {
  /** The wallets in this browser this terminal can use. */
  wallets: readonly Wallet[];
  /** Solana wallets in this browser that cannot be used, each with the reason. */
  rejected: readonly RejectedWallet[];
  /** The connected owner, or null: dropped at once on a disconnect or an account switch. */
  signer: OwnerSigner | null;
  connecting: boolean;
  /** Why the wallet ended the last session on its own, until the next connect or `dismissEnded`. */
  ended: SessionEnd | null;
  dismissEnded: () => void;
  connect: (wallet: Wallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Whether `signer` is still the connected owner; check after any await. */
  isCurrent: (signer: OwnerSigner) => boolean;
};

const WalletContext = createContext<StandardWallet>({
  wallets: [],
  rejected: [],
  signer: null,
  connecting: false,
  ended: null,
  dismissEnded: () => {},
  connect: async () => {},
  disconnect: async () => {},
  isCurrent: () => false,
});

export const useStandardWallet = () => useContext(WalletContext);

/**
 * The wallets of the wallet-standard, read straight from the browser: no
 * adapter, no wallet list of its own. Nothing is remembered between visits,
 * so every session starts by the owner choosing the wallet.
 */
export function StandardWalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [rejected, setRejected] = useState<readonly RejectedWallet[]>([]);
  const [session] = useState(createWalletSession);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => {
      const found = registry.get();
      setWallets(found.filter(isUsableWallet));
      setRejected(rejectedWallets(found));
    };
    const ready = setTimeout(refresh, 0);
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      clearTimeout(ready);
      offRegister();
      offUnregister();
    };
  }, []);

  const value: StandardWallet = {
    wallets,
    rejected,
    signer: state.connected?.signer ?? null,
    connecting: state.connecting,
    ended: state.ended,
    dismissEnded: session.dismissEnded,
    connect: session.connect,
    disconnect: session.disconnect,
    isCurrent: session.isCurrent,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
