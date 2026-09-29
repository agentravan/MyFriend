import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "NOVA", description: "Personal AI companion", robots: { index: false } };
export const viewport: Viewport = { themeColor: "#06090e", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Orbitron:wght@600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
