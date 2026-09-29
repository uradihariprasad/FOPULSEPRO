import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#04070e",
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "F&O Pulse — NSE Intraday Scanner & Trade Setup Engine",
  description:
    "Two-stage NSE F&O intraday scanner powered exclusively by Upstox API: abnormal participation, relative strength, dynamic support/resistance, option-chain confluence and futures confirmation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jbmono.variable}`}>
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
