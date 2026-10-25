/**
 * What a mainnet build trades on, fixed in code. A test network reads all of
 * this from `GET /v1/deployment`; on mainnet neither the environment nor the
 * service gets a say, because a wrong program, rollup or token here is real
 * money signed to the wrong place.
 */
export interface NetworkPins {
  network: string;
  programId: string;
  /** No trailing slash: the SDK appends `/auth/challenge`. */
  rollupRpcUrl: string;
  rollupWsUrl: string;
  /** The identity the rollup itself must report; never read from the deployment answer. */
  validator: string;
  /** The Solana cluster's genesis hash, which the Solana RPC must report before the owner signs. */
  solanaGenesis: string;
  /** The collateral and quote token. */
  usdcMint: string;
  /** The only markets launched on this network. */
  marketIds: readonly number[];
}

export const MAINNET_PINS: Readonly<NetworkPins> = Object.freeze({
  network: "mainnet",
  programId: "BrUoDsreaeXWypVxh6LoGseqwB4TZVJZBxvhfxXprvwP",
  rollupRpcUrl: "https://mainnet-tee.magicblock.app",
  rollupWsUrl: "wss://mainnet-tee.magicblock.app",
  validator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  solanaGenesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  marketIds: Object.freeze([0]),
});

interface DeploymentFacts {
  network: string;
  programId: string;
  markets: readonly { marketId: number; quoteToken: { mint: string } }[];
}

/** The first way `deployment` disagrees with `pins`, or null when it agrees. */
export function pinRefusal(pins: NetworkPins, deployment: DeploymentFacts): string | null {
  if (deployment.network !== pins.network) {
    return `the service describes the ${deployment.network} network, but this build trades on ${pins.network}`;
  }
  if (deployment.programId !== pins.programId) {
    return `the service describes program ${deployment.programId}, but this build trades on ${pins.programId}`;
  }
  const unlaunched = deployment.markets.find((market) => !pins.marketIds.includes(market.marketId));
  if (unlaunched) {
    return `the service lists market ${unlaunched.marketId}, which is not launched on ${pins.network}`;
  }
  const wrongMint = deployment.markets.find((market) => market.quoteToken.mint !== pins.usdcMint);
  if (wrongMint) {
    return `the service prices a market in token ${wrongMint.quoteToken.mint}, but this build trades only in ${pins.usdcMint}`;
  }
  return null;
}

/** A test build must never trade the real network under a test label. */
export function testBuildRefusal(deployment: DeploymentFacts): string | null {
  if (
    deployment.network === MAINNET_PINS.network ||
    deployment.programId === MAINNET_PINS.programId
  ) {
    return "the service describes the mainnet network, which only a mainnet build trades on";
  }
  return null;
}
