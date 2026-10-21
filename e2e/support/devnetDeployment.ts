/**
 * The devnet suites were written against the deployment that quotes its
 * markets in nUSD and hands each new address a 5,000 nUSD grant. A
 * deployment quoting in another token has no faucet, so a fresh wallet
 * there can never be funded and every balance this suite reads would carry
 * another symbol: those suites skip rather than fail against it.
 */
const SIM_DEVNET_URL = process.env.DEVNET_SIM_URL ?? "http://localhost:4100";

export const NOT_THE_NUSD_DEPLOYMENT =
  "targets the nUSD deployment with a faucet; the service in front of it quotes another token";

let quotesNusd: Promise<boolean> | null = null;

async function readQuotesNusd(): Promise<boolean> {
  const response = await fetch(`${SIM_DEVNET_URL}/v1/deployment`);
  if (!response.ok) throw new Error(`/v1/deployment answered ${response.status}`);
  const deployment = (await response.json()) as {
    markets?: { quoteToken?: { symbol?: string } }[];
  };
  return (deployment.markets ?? []).some((market) => market.quoteToken?.symbol === "nUSD");
}

/** Whether the devnet service in front of this suite is the nUSD deployment it was written for. Read once per run. */
export function isNusdDeployment(): Promise<boolean> {
  quotesNusd ??= readQuotesNusd();
  return quotesNusd;
}
