import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "NoirWire terminal",
  description: "A trading terminal for the NoirWire order book, on a test network.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0c",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page is rendered per request: the script nonce in the
  // Content-Security-Policy is new each time and cannot be prerendered.
  await connection();
  return (
    <html lang="en" className={`${figtree.variable} h-full antialiased`}>
      <body className="bg-base text-ink min-h-full">{children}</body>
    </html>
  );
}
