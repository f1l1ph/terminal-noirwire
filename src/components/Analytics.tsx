import { headers } from "next/headers";
import Script from "next/script";

const UMAMI_URL = process.env.NEXT_PUBLIC_UMAMI_URL;
const UMAMI_WEBSITE_ID = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

/**
 * Loads the self-hosted Umami tracker with the request's script nonce.
 * data-domains keeps preview deploys and local builds out of the numbers.
 */
export async function Analytics() {
  if (!UMAMI_URL || !UMAMI_WEBSITE_ID) return null;
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <Script
      src={`${UMAMI_URL}/script.js`}
      strategy="afterInteractive"
      nonce={nonce}
      data-website-id={UMAMI_WEBSITE_ID}
      data-domains="terminal.noirwire.com"
      data-do-not-track="true"
    />
  );
}
