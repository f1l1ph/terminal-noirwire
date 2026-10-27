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
  try {
    const held = await readDepositKeyLeftover(env);
    return held > 0n ? held : null;
  } catch {
    return null;
  }
}

/**
 * What the deposit key holds in the rollup: 0 for a key with no balance
 * account on Solana, and a throw when the balance cannot be read or the key
 * cannot sign in, so a failed read is never taken for an empty key.
 */
export async function readDepositKeyLeftover(env: TransferEnv): Promise<bigint> {
  const key = env.depositKey.publicKey;
  if (!(await env.solana.getAccountInfo(depositKeyBalance(key, env.mint), "confirmed"))) {
    return 0n;
  }
  const held = await readTokenBalance(await env.depositRollup(), depositKeyAccount(key, env.mint));
  if (held === null) throw new Error("the rollup does not show the deposit key's balance");
  return held;
}
