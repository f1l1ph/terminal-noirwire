"use client";

import { useEffect, useMemo, useState } from "react";
import { env } from "../env";
import { isMainnetBuild } from "../network";
import { mainnetOwnerSigner } from "../rollup/mainnetOwner";
import {
  clearOtherSignInTokens,
  clearSignInToken,
  trackConnectedOwner,
} from "../rollup/signInToken";
import type { WalletIdentity } from "../trading/types";
import { browserLocalStorage } from "./index";
import { useStandardWallet } from "./standardWallet";
import type { WalletHookResult } from "./useWallet";

/**
 * Who the trading client trades for. On a mainnet build that is the
 * connected Wallet Standard wallet, behind the network check that runs before
 * every signature, and nothing else: the built-in wallet is not consulted.
 * On a test build it is the built-in browser wallet. Null until an owner is
 * connected (mainnet) or unlocked (test).
 *
 * The rollup sign-in token kept for an owner is deleted the moment that owner
 * stops being the connected one (disconnect, or a switch to another account
 * in the wallet); a reload that finds the same owner connected again keeps it.
 */
export function useOwnerIdentity(builtIn: WalletHookResult): WalletIdentity | null {
  const { signer: connected } = useStandardWallet();
  const account = builtIn.account;
  const identity = useMemo<WalletIdentity | null>(() => {
    if (isMainnetBuild()) {
      if (!connected || !env.solanaRpcUrl) return null;
      const signer = mainnetOwnerSigner(connected, env.solanaRpcUrl);
      return { address: signer.publicKey.toBase58(), signer };
    }
    return account ? { address: account.publicKey, secretKeyHex: account.secretKeyHex } : null;
  }, [connected, account]);

  const [trackOwner] = useState(() =>
    trackConnectedOwner(
      (address) => clearSignInToken(browserLocalStorage(), address),
      (address) => {
        if (typeof window !== "undefined") clearOtherSignInTokens(window.localStorage, address);
      },
    ),
  );
  const address = identity?.address ?? null;
  useEffect(() => {
    trackOwner(address);
  }, [trackOwner, address]);

  return identity;
}
