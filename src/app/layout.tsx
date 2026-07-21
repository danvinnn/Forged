import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forge | Vertical Datasheet AI",
  description: "Vertical AI for datasheet lookup, part extraction, and CAD bundle generation"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}