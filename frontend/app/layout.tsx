import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenForge Mission Control",
  description: "24/7 autonomous AI agent operations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-bg-base font-sans text-text-primary selection:bg-accent-gold selection:text-white">
        {children}
      </body>
    </html>
  );
}
