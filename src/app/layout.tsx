import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // What the tab says while an engineer has six of them open. The part they are
  // working on is the useful half, and the tool name is the half they already
  // know, so the tool name goes second.
  title: "Forge",
  description: "Read a datasheet, get a schematic symbol, a footprint and a 3D body."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}