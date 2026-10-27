type NavigatorLike = { userAgent?: string; userAgentData?: { mobile?: boolean } };

const MOBILE_AGENT = /Android|iPhone|iPad|iPod|Mobile/i;

/** Whether this is a phone or tablet browser, where there is no extension to find: the wallet apps open the page in their own browser instead. */
export function isMobileBrowser(nav: NavigatorLike): boolean {
  if (typeof nav.userAgentData?.mobile === "boolean") return nav.userAgentData.mobile;
  return MOBILE_AGENT.test(nav.userAgent ?? "");
}

/** The link that opens `pageUrl` inside the Phantom app's browser. */
export function phantomBrowseUrl(pageUrl: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
}

/** The link that opens `pageUrl` inside the Solflare app's browser. */
export function solflareBrowseUrl(pageUrl: string, origin: string): string {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
}
