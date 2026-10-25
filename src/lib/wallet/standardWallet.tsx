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

/** A wallet this terminal can use: it connects, signs a transaction and a message, and names Solana mainnet. Anything less is not listed. */
export function isUsableWallet(wallet: Wallet): boolean {
  return (
    StandardConnect in wallet.features &&
    StandardEvents in wallet.features &&
    SolanaSignTransaction in wallet.features &&
    SolanaSignMessage in wallet.features &&
    wallet.chains.includes(MAINNET)
  );
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
type SessionState = { connected: Connected | null; connecting: boolean };

const IDLE: SessionState = { connected: null, connecting: false };
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
      set({ connected: null, connecting: true });

      let seen: readonly WalletAccount[] | undefined;
      let chosen: WalletAccount | null = null;
      const events = featureOf<EventsFeature>(wallet, StandardEvents);
      const off =
        events?.on("change", ({ accounts }) => {
          if (attempt !== mine) return;
          if (accounts) seen = accounts;
          if (!chosen) return;
          const held = (accounts ?? wallet.accounts).some(
            (account) => account.address === chosen?.address,
          );
          if (!held || !isUsableWallet(wallet)) {
            attempt += 1;
            letGo();
            set(IDLE);
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
        set({ connected: { wallet, account, signer, generation: attempt }, connecting: false });
      } catch (error) {
        off();
        if (attempt === mine) set(IDLE);
        throw error;
      }
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
  /** The connected owner, or null: dropped at once on a disconnect or an account switch. */
  signer: OwnerSigner | null;
  connecting: boolean;
  connect: (wallet: Wallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Whether `signer` is still the connected owner; check after any await. */
  isCurrent: (signer: OwnerSigner) => boolean;
};

const WalletContext = createContext<StandardWallet>({
  wallets: [],
  signer: null,
  connecting: false,
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
  const [session] = useState(createWalletSession);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(registry.get().filter(isUsableWallet));
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
    signer: state.connected?.signer ?? null,
    connecting: state.connecting,
    connect: session.connect,
    disconnect: session.disconnect,
    isCurrent: session.isCurrent,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
