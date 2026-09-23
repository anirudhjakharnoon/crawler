import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { AmbientLayer } from "@/components/ambient/AmbientLayer";
import { AuthProvider } from "@/components/providers/AuthProvider";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CRAWLR — precision content extraction",
  description:
    "Paste a URL, choose Text / Images / Video, choose scope, and run a robots.txt-respecting, SSRF-hardened static-HTML crawl. No AI. No re-hosting. No login required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} ${spaceGrotesk.variable}`}>
      <body className="relative min-h-screen font-mono antialiased">
        <AmbientLayer />
        <AuthProvider>
          <div className="relative z-10">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
