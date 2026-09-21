import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "./globals.css";

const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "IntentTrace · Local trace workbench",
  description: "Evidence-backed local agent trace workbench",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
