/**
 * Whether this build trades real money. Read straight from the build-time
 * variable, so the answer cannot be swayed by anything that runs in the page.
 */
export const isMainnetBuild = (): boolean => process.env.NEXT_PUBLIC_NETWORK === "mainnet";

/**
 * Throws on a mainnet build. Guards every path that would put an owner secret
 * in the page: a mainnet build holds no wallet secret of its own, the owner
 * signs in a wallet it connects.
 */
export function refuseOnMainnet(what: string): void {
  if (isMainnetBuild()) {
    throw new Error(`${what} is not available on a mainnet build: connect a wallet instead`);
  }
}
