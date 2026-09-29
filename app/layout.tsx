import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "NOVA", description: "Personal AI companion", robots: { index: false } };
export const viewport: Viewport = { themeColor: "#03060b", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
