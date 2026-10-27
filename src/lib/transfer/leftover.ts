import { depositKeyAccount, depositKeyBalance } from "./depositKey";
import type { TransferEnv } from "./operation";
import { readTokenBalance } from "./solanaRpc";

/**
 * What the deposit key holds in the rollup, or null when nothing is waiting.
 * It never asks the wallet: a key that never moved anything has no balance
 * account on Solana and is not signed in for, and otherwise the key signs in
 * for itself to read its own token account. A read that fails is nothing to
 * show, since the next look reads again.
 */
export async function depositKeyLeftover(env: TransferEnv): Promise<bigint | null> {
  const key = env.depositKey.publicKey;
  try {
    if (!(await env.solana.getAccountInfo(depositKeyBalance(key, env.mint), "confirmed"))) {
      return null;
    }
    const held = await readTokenBalance(
      await env.depositRollup(),
      depositKeyAccount(key, env.mint),
    );
    return held !== null && held > 0n ? held : null;
  } catch {
    return null;
  }
}
