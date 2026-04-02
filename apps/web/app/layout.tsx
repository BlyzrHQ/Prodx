import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prodx",
  description: "Prepare better Shopify catalogs locally with Prodx."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
